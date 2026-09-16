export type Money = {
  amount: number
  currency: string
}

export type Pagination = {
  page: number
  pageSize: number
  total: number
}

export type ApiResponse<T> = {
  data: T
  pagination?: Pagination
  requestId?: string
}
