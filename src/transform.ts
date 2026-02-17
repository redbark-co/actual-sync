import type { RedbarkTransaction } from './types.js'

export interface ActualTransaction {
  date: string
  amount: number
  payee_name: string
  imported_payee: string
  imported_id: string
  notes?: string
  cleared: boolean
}

/**
 * Convert a dollar amount string to integer cents.
 * "12.50" → 1250, "0.99" → 99, "1000" → 100000
 */
export function amountToInteger(amount: string): number {
  return Math.round(parseFloat(amount) * 100)
}

/**
 * Transform a Redbark transaction into Actual Budget's import format.
 *
 * - Amount: converted to integer cents. Debit = negative, credit = positive.
 * - imported_id: prefixed with "redbark:" to avoid collision with other importers.
 * - payee_name: uses merchantName if available, falls back to description.
 * - cleared: true for posted transactions (we only import posted).
 */
export function toActualTransaction(
  txn: RedbarkTransaction
): ActualTransaction {
  const absAmount = amountToInteger(txn.amount)
  const signedAmount = txn.direction === 'debit' ? -absAmount : absAmount

  const notes = [txn.category, txn.merchantCategoryCode]
    .filter(Boolean)
    .join(' | ')

  return {
    date: txn.date,
    amount: signedAmount,
    payee_name: txn.merchantName || txn.description,
    imported_payee: txn.description,
    imported_id: `redbark:${txn.id}`,
    notes: notes || undefined,
    cleared: txn.status === 'posted',
  }
}

/**
 * Transform a batch of Redbark transactions, filtering to posted only.
 */
export function transformTransactions(
  transactions: RedbarkTransaction[]
): ActualTransaction[] {
  return transactions
    .filter((txn) => txn.status === 'posted')
    .map(toActualTransaction)
}
