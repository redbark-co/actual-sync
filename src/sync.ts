import { logger } from './logger.js'
import { RedbarkClient } from './redbark-client.js'
import { withActualBudget } from './actual-client.js'
import { transformTransactions } from './transform.js'
import type { Config } from './config.js'
import type { SyncResult } from './types.js'

/**
 * Run the full sync pipeline:
 * 1. Fetch transactions from Redbark for each mapped account
 * 2. Transform to Actual Budget format
 * 3. Import into Actual Budget
 */
export async function runSync(config: Config): Promise<SyncResult[]> {
  const redbark = new RedbarkClient(config.redbarkApiKey, config.redbarkApiUrl)

  // Validate Redbark connection and get accounts
  logger.info('Connecting to Redbark API...')
  const accounts = await redbark.listAccounts()
  logger.info(
    { accountCount: accounts.length },
    `Connected to Redbark API (${accounts.length} accounts)`
  )

  // Build a lookup map for Redbark accounts
  const redbarkAccountMap = new Map(accounts.map((a) => [a.id, a]))

  // Validate all mapped Redbark accounts exist
  for (const mapping of config.accountMapping) {
    const account = redbarkAccountMap.get(mapping.redbarkAccountId)
    if (!account) {
      throw new Error(
        `Redbark account ID '${mapping.redbarkAccountId}' not found.\n` +
          '  → Run with --list-redbark-accounts to see available accounts.'
      )
    }
  }

  // Calculate date range
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - config.syncDays)
  const fromStr = from.toISOString().split('T')[0]!
  const toStr = to.toISOString().split('T')[0]!

  logger.info({ from: fromStr, to: toStr, days: config.syncDays }, 'Sync window')

  // Connect to Actual Budget and run sync
  return withActualBudget(
    {
      serverUrl: config.actualServerUrl,
      password: config.actualPassword,
      budgetId: config.actualBudgetId,
      encryptionPassword: config.actualEncryptionPassword,
      dataDir: config.actualDataDir,
    },
    async ({ getAccounts, importTransactions }) => {
      // Validate all mapped Actual accounts exist
      const actualAccounts = await getAccounts()
      const actualAccountMap = new Map(actualAccounts.map((a) => [a.id, a]))

      for (const mapping of config.accountMapping) {
        if (!actualAccountMap.has(mapping.actualAccountId)) {
          throw new Error(
            `Actual Budget account ID '${mapping.actualAccountId}' not found.\n` +
              '  → Run with --list-actual-accounts to see available accounts.'
          )
        }
      }

      logger.info(
        { budgetAccounts: actualAccounts.length },
        'Connected to Actual Budget'
      )

      const results: SyncResult[] = []

      // Sync each account mapping
      for (const mapping of config.accountMapping) {
        const redbarkAccount = redbarkAccountMap.get(mapping.redbarkAccountId)!
        const actualAccount = actualAccountMap.get(mapping.actualAccountId)!

        logger.info(
          `Syncing: ${redbarkAccount.name} → ${actualAccount.name}`
        )

        // Fetch transactions from Redbark
        const transactions = await redbark.getTransactions({
          connectionId: redbarkAccount.connectionId,
          accountId: redbarkAccount.id,
          from: fromStr,
          to: toStr,
        })

        logger.info(
          { count: transactions.length },
          `Fetched ${transactions.length} transactions (${config.syncDays} days)`
        )

        // Transform to Actual format (filters to posted only)
        const actualTransactions = transformTransactions(transactions)

        if (actualTransactions.length === 0) {
          logger.info('No posted transactions to import')
          results.push({
            redbarkAccountId: mapping.redbarkAccountId,
            actualAccountId: mapping.actualAccountId,
            accountName: redbarkAccount.name,
            fetched: transactions.length,
            added: 0,
            updated: 0,
            errors: 0,
          })
          continue
        }

        if (config.dryRun) {
          logger.info(
            `[DRY RUN] Would import ${actualTransactions.length} transactions to '${actualAccount.name}'`
          )
          results.push({
            redbarkAccountId: mapping.redbarkAccountId,
            actualAccountId: mapping.actualAccountId,
            accountName: redbarkAccount.name,
            fetched: transactions.length,
            added: actualTransactions.length,
            updated: 0,
            errors: 0,
          })
          continue
        }

        // Import into Actual Budget
        const importResult = await importTransactions(
          mapping.actualAccountId,
          actualTransactions,
          { reimportDeleted: config.actualReimportDeleted }
        )

        const added = Array.isArray(importResult.added)
          ? importResult.added.length
          : 0
        const updated = Array.isArray(importResult.updated)
          ? importResult.updated.length
          : 0
        const errors = Array.isArray(importResult.errors)
          ? importResult.errors.length
          : 0

        logger.info(
          { added, updated, errors },
          `Imported: ${added} added, ${updated} updated, ${errors} errors`
        )

        results.push({
          redbarkAccountId: mapping.redbarkAccountId,
          actualAccountId: mapping.actualAccountId,
          accountName: redbarkAccount.name,
          fetched: transactions.length,
          added,
          updated,
          errors,
        })
      }

      return results
    }
  )
}
