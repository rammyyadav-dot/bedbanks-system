// Admin funding receipts (ADR 0028 slice 2). No mock or fallback data lives here.
import { routes, type FundingDeclareRequest, type FundingReceiptView, type Paged } from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

const f = routes.adminFunding
const fill = (path: string, receiptId: string) => path.replace(':receiptId', encodeURIComponent(receiptId))
const post = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const getFundingReceipts = (p: Record<string, string | number | undefined>) => apiRequest<Paged<FundingReceiptView>>(`${f.receipts}${opsQuery(p)}`)
export const declareFunding = (body: FundingDeclareRequest) => post<FundingReceiptView>(f.receipts, body)
export const verifyFunding = (id: string, note: string) => post<FundingReceiptView>(fill(f.verify, id), { note })
export const clearFundingCompliance = (id: string, note: string) => post<FundingReceiptView>(fill(f.clearCompliance, id), { note })
export const postFunding = (id: string) => post<FundingReceiptView>(fill(f.post, id), {})
export const rejectFunding = (id: string, reason: string) => post<FundingReceiptView>(fill(f.reject, id), { reason })
