import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { logger } from './logger.js'
import type { ActualTransaction } from './transform.js'

// Polyfill `navigator` for @actual-app/api which references it in Node.js
// (still required as of 26.4 — see @actual-app/core/src/shared/platform.ts).
// See: https://github.com/actualbudget/actual/issues/7201
if (typeof globalThis.navigator === 'undefined') {
  // @ts-expect-error minimal polyfill for Node.js
  globalThis.navigator = { userAgent: 'node' }
}

export class ApiVersionMismatchError extends Error {
  readonly serverVersion: string
  readonly bundledVersion: string
  readonly downloadError: string

  constructor(serverVersion: string, bundledVersion: string, downloadError: string) {
    super(
      [
        `Actual Budget server is on ${serverVersion}, but this container ships @actual-app/api ${bundledVersion}.`,
        `Tried to download a matching API at runtime, but it failed: ${downloadError}.`,
        `Not falling back to the bundled API because it is older than the server — if the budget contains migrations only the server knows, @actual-app/api will refuse to open it with "out-of-sync-migrations".`,
        `Fix: upgrade this container to a newer redbark-co/actual-sync image, or pin your Actual server to ${bundledVersion}.`,
      ].join(' ')
    )
    this.name = 'ApiVersionMismatchError'
    this.serverVersion = serverVersion
    this.bundledVersion = bundledVersion
    this.downloadError = downloadError
  }
}

interface ActualConfig {
  serverUrl: string
  password: string
  budgetId: string
  encryptionPassword?: string
  dataDir: string
}

interface ImportResult {
  added: unknown[]
  updated: unknown[]
  errors: unknown[]
}

interface ActualAccount {
  id: string
  name: string
  type?: string
  offbudget?: boolean
  closed?: boolean
}

/**
 * Fetch the Actual server version from its /info endpoint.
 */
async function getServerVersion(serverUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/info`)
    if (!response.ok) return null
    const data = (await response.json()) as { build?: { version?: string } }
    return data.build?.version ?? null
  } catch {
    return null
  }
}

interface DownloadResult {
  path: string | null
  error: string | null
}

function downloadMatchingApi(version: string, dataDir: string): DownloadResult {
  const pkgDir = join(dataDir, `actual-api-${version}`)

  if (existsSync(join(pkgDir, 'node_modules', '@actual-app', 'api'))) {
    logger.debug({ version, pkgDir }, 'Using cached @actual-app/api')
    return {
      path: join(pkgDir, 'node_modules', '@actual-app', 'api'),
      error: null,
    }
  }

  logger.info(
    { version },
    'Downloading matching @actual-app/api from npm (will be cached for next run)'
  )

  try {
    mkdirSync(pkgDir, { recursive: true })

    const pkgJson = JSON.stringify({
      name: 'actual-api-loader',
      private: true,
      dependencies: { '@actual-app/api': version },
    })

    writeFileSync(join(pkgDir, 'package.json'), pkgJson)
    execSync('npm install --no-audit --no-fund', {
      cwd: pkgDir,
      stdio: 'pipe',
      timeout: 120_000,
    })

    const apiPath = join(pkgDir, 'node_modules', '@actual-app', 'api')
    if (existsSync(apiPath)) {
      logger.info({ version }, 'Successfully installed matching @actual-app/api')
      return { path: apiPath, error: null }
    }

    return { path: null, error: 'npm install completed but package not found' }
  } catch (error) {
    return { path: null, error: extractNpmError(error) }
  }
}

function extractNpmError(error: unknown): string {
  const raw = error instanceof Error ? (error.message ?? String(error)) : String(error)
  // execSync surfaces both stdout and stderr inside Error.message; pluck the
  // most informative line so the user sees the actual failure, not a wall of
  // node-gyp output.
  if (raw.includes('Could not find any Python installation')) {
    return 'native build toolchain missing (python3 not available) — better-sqlite3 has no prebuilt binary for this Node ABI/arch and cannot be compiled from source in this container'
  }
  if (raw.includes('prebuild-install')) {
    const match = raw.match(/No prebuilt binaries found[^\n]*/)
    if (match) return match[0]
  }
  return raw.split('\n').slice(0, 3).join(' ').slice(0, 500)
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.split('-')[0]!.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const [pa, pb] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

/**
 * Read the bundled @actual-app/api version from disk without importing
 * `@actual-app/api/package.json`, which is blocked by the package exports map.
 */
function getBundledApiVersion(): string | null {
  try {
    const apiEntryPath = require.resolve('@actual-app/api')
    const packageJsonPath = join(dirname(apiEntryPath), '..', 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version?: string
    }
    return packageJson.version ?? null
  } catch (error) {
    logger.warn(
      { error: String(error) },
      'Failed to determine bundled @actual-app/api version'
    )
    return null
  }
}

/**
 * Load the @actual-app/api module, optionally matching the server version.
 */
async function loadActualApi(
  serverUrl: string,
  dataDir: string
): Promise<typeof import('@actual-app/api')> {
  const serverVersion = await getServerVersion(serverUrl)

  if (serverVersion) {
    const bundledVersion = getBundledApiVersion()

    if (!bundledVersion) {
      logger.debug(
        'Could not determine bundled @actual-app/api version, using bundled API'
      )
    } else if (serverVersion !== bundledVersion) {
      logger.info(
        { serverVersion, bundledVersion },
        'Actual Budget server version differs from bundled API'
      )

      const serverIsNewer = compareSemver(serverVersion, bundledVersion) > 0
      const { path: matchingPath, error: downloadError } = downloadMatchingApi(
        serverVersion,
        dataDir
      )

      if (matchingPath) {
        try {
          return require(matchingPath) as typeof import('@actual-app/api')
        } catch (error) {
          // Server newer than bundled → bundled cannot open the DB without
          // hitting @actual-app/api's out-of-sync-migrations guard. Surface
          // the version mismatch instead of letting that opaque error fire.
          if (serverIsNewer) {
            throw new ApiVersionMismatchError(
              serverVersion,
              bundledVersion,
              `loaded downloaded API at ${matchingPath} but require() failed: ${String(error)}`
            )
          }
          logger.warn(
            { error: String(error) },
            'Failed to load downloaded API, using bundled version'
          )
        }
      } else if (serverIsNewer) {
        throw new ApiVersionMismatchError(
          serverVersion,
          bundledVersion,
          downloadError ?? 'unknown download failure'
        )
      } else {
        logger.warn(
          { serverVersion, bundledVersion, downloadError },
          'Could not download matching @actual-app/api; falling back to bundled API'
        )
      }
    } else {
      logger.debug(
        { version: bundledVersion },
        'Server and bundled API versions match'
      )
    }
  } else {
    logger.debug('Could not determine Actual server version, using bundled API')
  }

  return await import('@actual-app/api')
}

/**
 * Run an operation against Actual Budget with full lifecycle management.
 * Handles: init → downloadBudget → operation → sync → shutdown
 */
export async function withActualBudget<T>(
  config: ActualConfig,
  fn: (helpers: {
    api: typeof import('@actual-app/api')
    getAccounts: () => Promise<ActualAccount[]>
    importTransactions: (
      accountId: string,
      transactions: ActualTransaction[],
      opts?: { reimportDeleted?: boolean }
    ) => Promise<ImportResult>
  }) => Promise<T>
): Promise<T> {
  mkdirSync(config.dataDir, { recursive: true })

  const api = await loadActualApi(config.serverUrl, config.dataDir)

  // Handle graceful shutdown
  let shutdownCalled = false
  const cleanup = async () => {
    if (shutdownCalled) return
    shutdownCalled = true
    try {
      await api.shutdown()
    } catch {
      // Best-effort cleanup
    }
  }

  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  try {
    await api.init({
      dataDir: config.dataDir,
      serverURL: config.serverUrl,
      password: config.password,
    })

    const downloadOpts = config.encryptionPassword
      ? { password: config.encryptionPassword }
      : undefined

    await api.downloadBudget(config.budgetId, downloadOpts)

    logger.info('Connected to Actual Budget')

    const result = await fn({
      api,
      getAccounts: async () => {
        return (await api.getAccounts()) as ActualAccount[]
      },
      importTransactions: async (accountId, transactions, opts) => {
        // The API type requires `account` on each transaction object
        const withAccount = transactions.map((t) => ({
          ...t,
          account: accountId,
        }))
        return (await api.importTransactions(accountId, withAccount, opts)) as ImportResult
      },
    })

    await api.sync()
    logger.debug('Synced changes to Actual Budget server')

    return result
  } finally {
    process.removeListener('SIGTERM', cleanup)
    process.removeListener('SIGINT', cleanup)
    await cleanup()
  }
}

/**
 * List accounts from Actual Budget (for --list-actual-accounts).
 */
export async function listActualAccounts(
  config: ActualConfig
): Promise<ActualAccount[]> {
  return withActualBudget(config, async ({ getAccounts }) => {
    return getAccounts()
  })
}
