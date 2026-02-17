import { logger } from './logger.js'
import type {
  RedbarkAccount,
  RedbarkConnection,
  RedbarkTransaction,
} from './types.js'

interface TransactionsParams {
  connectionId: string
  accountId?: string
  from?: string
  to?: string
  limit?: number
}

interface TransactionsResponse {
  transactions: RedbarkTransaction[]
  cursor: string | null
  hasMore: boolean
}

interface ConnectionsResponse {
  connections: RedbarkConnection[]
}

interface AccountsResponse {
  accounts: RedbarkAccount[]
}

const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 30_000

export class RedbarkClient {
  private baseUrl: string
  private apiKey: string
  private userAgent: string

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.userAgent = `redbark-actual-sync/0.1.0`
  }

  async listConnections(): Promise<RedbarkConnection[]> {
    const data = await this.get<ConnectionsResponse>('/api/v1/connections')
    return data.connections
  }

  async listAccounts(): Promise<RedbarkAccount[]> {
    const data = await this.get<AccountsResponse>('/api/v1/accounts')
    return data.accounts
  }

  async getTransactions(
    params: TransactionsParams
  ): Promise<RedbarkTransaction[]> {
    const allTransactions: RedbarkTransaction[] = []
    let cursor: string | null = null

    do {
      const query = new URLSearchParams({
        connectionId: params.connectionId,
        limit: String(params.limit ?? 200),
      })

      if (params.accountId) query.set('accountId', params.accountId)
      if (params.from) query.set('from', params.from)
      if (params.to) query.set('to', params.to)
      if (cursor) query.set('cursor', cursor)

      const data = await this.get<TransactionsResponse>(
        `/api/v1/transactions?${query.toString()}`
      )

      allTransactions.push(...data.transactions)
      cursor = data.cursor

      logger.debug(
        { page: allTransactions.length, hasMore: data.hasMore },
        'Fetched transaction page'
      )
    } while (cursor)

    return allTransactions
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
      )

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': this.userAgent,
            Accept: 'application/json',
          },
          signal: controller.signal,
        })

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After')
          const waitMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1)

          logger.warn(
            { attempt, waitMs },
            'Rate limited by Redbark API, retrying'
          )
          await sleep(waitMs)
          continue
        }

        if (response.status === 401) {
          throw new RedbarkApiError(
            'Redbark API returned 401 Unauthorized. Your API key may be revoked or expired.\n  → Check https://app.redbark.io/settings/api-keys',
            response.status
          )
        }

        if (response.status === 403) {
          throw new RedbarkApiError(
            'Redbark API returned 403 Forbidden. You do not have access to this resource.',
            response.status
          )
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new RedbarkApiError(
            `Redbark API returned ${response.status}: ${body}`,
            response.status
          )
        }

        return (await response.json()) as T
      } catch (error) {
        if (error instanceof RedbarkApiError) throw error

        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
          logger.warn(
            { attempt, delay, error: String(error) },
            'Request failed, retrying'
          )
          await sleep(delay)
          continue
        }

        throw new RedbarkApiError(
          `Failed to reach Redbark API after ${MAX_RETRIES} attempts: ${error}`,
          0
        )
      } finally {
        clearTimeout(timeout)
      }
    }

    throw new RedbarkApiError(
      `Failed to reach Redbark API after ${MAX_RETRIES} attempts`,
      0
    )
  }
}

export class RedbarkApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RedbarkApiError'
    this.status = status
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
