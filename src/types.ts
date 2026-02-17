export interface RedbarkConnection {
  id: string
  provider: string
  institutionName: string
  institutionLogo?: string
  status: string
  accounts: RedbarkAccount[]
}

export interface RedbarkAccount {
  id: string
  connectionId: string
  provider: string
  name: string
  type: string
  institutionName: string
  accountNumber?: string
  balance?: string
  availableBalance?: string
  currency?: string
}

export interface RedbarkTransaction {
  id: string
  accountId: string
  accountName: string
  status: string
  date: string
  description: string
  amount: string
  direction: 'credit' | 'debit'
  category?: string
  merchantName?: string
  merchantCategoryCode?: string
}

export interface AccountMapping {
  redbarkAccountId: string
  actualAccountId: string
}

export interface SyncResult {
  redbarkAccountId: string
  actualAccountId: string
  accountName: string
  fetched: number
  added: number
  updated: number
  errors: number
}

export interface PaginatedResponse<T> {
  data: T[]
  cursor: string | null
  hasMore: boolean
}
