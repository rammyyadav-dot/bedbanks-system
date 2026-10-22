// The backlog of the booking Finance consumer (ADR 0076). Read-only; no mock or fallback data lives here.
import { routes, type PostingBacklogView, type PayablesAgingView, type PayablesDueView, type SupplierTermsListView, type SupplierTermsSetRequest, type SupplierTermsView, type SettlementListView, type SettlementProposeRequest, type SettlementView, type PostedPayablesView, type RevenueReportView } from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

export const getBookingPostingBacklog = () => apiRequest<PostingBacklogView>(routes.adminBookingFinancePostings.backlog)
export const getBookingRevenue = (p: { from?: string; to?: string }) => apiRequest<RevenueReportView>(`${routes.adminBookingFinancePostings.revenue}${opsQuery(p)}`)
export const getPostedPayables = () => apiRequest<PostedPayablesView>(routes.adminBookingFinancePostings.payables)
export const getPayablesAging = () => apiRequest<PayablesAgingView>(routes.adminBookingFinancePostings.payablesAging)

const s = routes.adminSupplierSettlements
const post = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const getSettlements = (p: { status?: string; supplierId?: string } = {}) => apiRequest<SettlementListView>(`${s.list}${opsQuery(p)}`)
export const proposeSettlement = (body: SettlementProposeRequest) => post<SettlementView>(s.list, body)
export const approveSettlement = (id: string) => post<SettlementView>(s.approve.replace(':settlementId', encodeURIComponent(id)), {})
export const rejectSettlement = (id: string, reason: string) => post<SettlementView>(s.reject.replace(':settlementId', encodeURIComponent(id)), { reason })
export const getPayablesDue = () => apiRequest<PayablesDueView>(routes.adminBookingFinancePostings.payablesDue)
export const getSupplierTerms = () => apiRequest<SupplierTermsListView>(routes.adminSupplierTerms.list)
export const setSupplierTerms = (body: SupplierTermsSetRequest) => post<SupplierTermsView>(routes.adminSupplierTerms.list, body)
