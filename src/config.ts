import { z } from 'zod'
import type { AccountMapping } from './types.js'

const accountMappingSchema = z
  .string()
  .min(1)
  .transform((val): AccountMapping[] => {
    return val.split(',').map((pair) => {
      const [redbarkAccountId, actualAccountId] = pair.trim().split(':')
      if (!redbarkAccountId || !actualAccountId) {
        throw new Error(
          `Invalid account mapping "${pair}". Expected format: redbark_id:actual_id`
        )
      }
      return {
        redbarkAccountId: redbarkAccountId.trim(),
        actualAccountId: actualAccountId.trim(),
      }
    })
  })

const configSchema = z.object({
  redbarkApiKey: z.string().min(1, 'REDBARK_API_KEY is required'),
  redbarkApiUrl: z.string().url().default('https://api.redbark.co'),
  actualServerUrl: z.string().min(1, 'ACTUAL_SERVER_URL is required'),
  actualPassword: z.string().min(1, 'ACTUAL_PASSWORD is required'),
  actualBudgetId: z.string().min(1, 'ACTUAL_BUDGET_ID is required'),
  actualEncryptionPassword: z.string().optional(),
  actualDataDir: z.string().default('./data'),
  accountMapping: accountMappingSchema,
  syncDays: z.coerce.number().int().positive().default(30),
  logLevel: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
  dryRun: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
})

export type Config = z.infer<typeof configSchema>

export function loadConfig(overrides?: Partial<Record<string, string>>): Config {
  const env = { ...process.env, ...overrides }

  const result = configSchema.safeParse({
    redbarkApiKey: env.REDBARK_API_KEY,
    redbarkApiUrl: env.REDBARK_API_URL || 'https://api.redbark.co',
    actualServerUrl: env.ACTUAL_SERVER_URL,
    actualPassword: env.ACTUAL_PASSWORD,
    actualBudgetId: env.ACTUAL_BUDGET_ID,
    actualEncryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
    actualDataDir: env.ACTUAL_DATA_DIR || './data',
    accountMapping: env.ACCOUNT_MAPPING,
    syncDays: env.SYNC_DAYS || '30',
    logLevel: env.LOG_LEVEL || 'info',
    dryRun: env.DRY_RUN || 'false',
  })

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => {
        const field = issue.path.join('.')
        return `  ${field}: ${issue.message}`
      })
      .join('\n')

    throw new ConfigError(`Invalid configuration:\n${errors}`)
  }

  return result.data
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Parse account mapping from CLI --accounts flag format: "redbark_id:actual_id,..."
 */
export function parseAccountMapping(input: string): AccountMapping[] {
  const result = accountMappingSchema.safeParse(input)
  if (!result.success) {
    throw new ConfigError(
      `Invalid account mapping: ${result.error.issues[0]?.message}`
    )
  }
  return result.data
}
