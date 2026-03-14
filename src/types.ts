export interface RedbarkConnection {
  id: string
  provider: string
  category: string
  institutionId: string
  institutionName: string
  institutionLogo: string | null
  status: string
  lastRefreshedAt: string | null
  createdAt: string
}

export interface RedbarkAccount {
  id: string
  connectionId: string
  provider: string | null
  name: string
  type: string
  institutionName: string | null
  accountNumber: string | null
  currency: string
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

export interface PaginationInfo {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: PaginationInfo
}
