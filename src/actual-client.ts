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

/**
 * Download a specific version of @actual-app/api from npm into the data directory.
 * Returns the path to the installed package, or null if it fails.
 */
function downloadMatchingApi(
  version: string,
  dataDir: string
): string | null {
  const pkgDir = join(dataDir, `actual-api-${version}`)

  if (existsSync(join(pkgDir, 'node_modules', '@actual-app', 'api'))) {
    logger.debug({ version, pkgDir }, 'Using cached @actual-app/api')
    return join(pkgDir, 'node_modules', '@actual-app', 'api')
  }

  logger.info(
    { version },
    'Downloading matching @actual-app/api from npm (will be cached for next run)'
  )

  try {
    mkdirSync(pkgDir, { recursive: true })

    // Write a minimal package.json so npm install works
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
      return apiPath
    }

    return null
  } catch (error) {
    logger.warn(
      { version, error: String(error) },
      'Failed to download matching @actual-app/api, falling back to bundled version'
    )
    return null
  }
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

      const matchingPath = downloadMatchingApi(serverVersion, dataDir)
      if (matchingPath) {
        try {
          return require(matchingPath) as typeof import('@actual-app/api')
        } catch (error) {
          logger.warn(
            { error: String(error) },
            'Failed to load downloaded API, using bundled version'
          )
        }
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
      transactions: ActualTransaction[]
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
      importTransactions: async (accountId, transactions) => {
        // The API type requires `account` on each transaction object
        const withAccount = transactions.map((t) => ({
          ...t,
          account: accountId,
        }))
        return (await api.importTransactions(accountId, withAccount)) as ImportResult
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
