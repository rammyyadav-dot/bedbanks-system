// Admin operations API access. Read-only except reconcile; no mock or fallback data lives here.
import { routes, type BookingDetailView, type BookingListPage, type AgencyAccountView, type ReceivablesView, type AccessReviewPage, type AccessReviewSummary, type MarketsSummary, type ReliabilitySummary, type ReconciliationApprovalExecution, type ReconciliationApprovalRequest, type ReconciliationApprovalView, type AuditSummary, type FinanceSummary, type AuditEventView, type CancellationRow, type ConnectorRow, type HoldDetail, type HoldRow, type LedgerEntryView, type OperationsCapabilities, type OperationsReadiness, type Paged, type ReconcileResponse, type ReconciliationQueue, type SupplierOperationsRow, type WalletRow } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const ops = routes.adminOperations
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const json = { 'Content-Type': 'application/json' }

export const getOpsCapabilities = () => apiRequest<OperationsCapabilities>(ops.capabilities)
export const getOpsReadiness = (p: Params = {}) => apiRequest<OperationsReadiness>(`${ops.readiness}${opsQuery(p)}`)
export const getFinanceSummary = (p: Params = {}) => apiRequest<FinanceSummary>(`${ops.financeSummary}${opsQuery(p)}`)
export const getAuditSummary = (p: Params = {}) => apiRequest<AuditSummary>(`${ops.auditSummary}${opsQuery(p)}`)
export const getOpsSuppliers = (p: Params) => apiRequest<Paged<SupplierOperationsRow>>(`${ops.suppliers}${opsQuery(p)}`)
export const getOpsHolds = (p: Params) => apiRequest<Paged<HoldRow>>(`${ops.holds}${opsQuery(p)}`)
export const getOpsHold = (holdId: string) => apiRequest<HoldDetail>(fill(ops.hold, { holdId }))
/** Booking list and detail (ADR 0039). The detail takes the booking id or its FB- reference. */
export const getOpsBookings = (p: Params) => apiRequest<BookingListPage>(`${ops.bookings}${opsQuery(p)}`)
export const getOpsBooking = (bookingIdOrReference: string) => apiRequest<BookingDetailView>(fill(ops.booking, { bookingId: bookingIdOrReference }))
/** Same-origin URL of an already-issued, immutable document (opened in a new tab; the API never issues one from Admin). */
export const opsDocumentUrl = (bookingId: string, type: 'voucher' | 'invoice' | 'credit-note') => `/api/v1${fill(ops.bookingDocument, { bookingId, type })}`
export const getOpsReconciliation = () => apiRequest<ReconciliationQueue>(ops.reconciliation)
export const runOpsReconciliation = (body: { staleMinutes?: number; prebookMaxMinutes?: number } = {}) => apiRequestWithMeta<ReconcileResponse>(ops.reconcile, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const getOpsCancellations = (p: Params) => apiRequest<Paged<CancellationRow>>(`${ops.cancellations}${opsQuery(p)}`)
export const getOpsWallets = (p: Params) => apiRequest<Paged<WalletRow>>(`${ops.wallets}${opsQuery(p)}`)
/** One agency's account position (ADR 0028 slice 1, read-only). */
export const getOpsReceivables = () => apiRequest<ReceivablesView>(ops.receivables)
export const getOpsAgencyAccount = (agencyId: string) => apiRequest<AgencyAccountView>(fill(ops.agencyAccount, { agencyId }))
export const getOpsLedger = (p: Params) => apiRequest<Paged<LedgerEntryView>>(`${ops.ledger}${opsQuery(p)}`)
export const getOpsAudit = (p: Params) => apiRequest<Paged<AuditEventView>>(`${ops.audit}${opsQuery(p)}`)
export const getOpsConnectors = (p: Params) => apiRequest<Paged<ConnectorRow>>(`${ops.connectors}${opsQuery(p)}`)

// ---- maker-checker for a reconciliation run (ADR 0017) -----------------------------------------------------------------
const approvalPath = (id: string, route: string) => fill(route, { approvalId: id })
export const getReconciliationApprovals = (p: Params = {}) => apiRequest<Paged<ReconciliationApprovalView>>(`${ops.reconciliationApprovals}${opsQuery(p)}`)
export const requestReconciliationApproval = (body: ReconciliationApprovalRequest) => apiRequestWithMeta<ReconciliationApprovalView>(ops.reconciliationApprovals, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const decideReconciliationApproval = (id: string, decision: 'approve' | 'reject', reason: string) => apiRequestWithMeta<ReconciliationApprovalView>(approvalPath(id, decision === 'approve' ? ops.reconciliationApprovalApprove : ops.reconciliationApprovalReject), { method: 'POST', headers: json, body: JSON.stringify({ reason }) })
export const cancelReconciliationApproval = (id: string) => apiRequestWithMeta<ReconciliationApprovalView>(approvalPath(id, ops.reconciliationApprovalCancel), { method: 'POST', headers: json, body: '{}' })
export const executeReconciliationApproval = (id: string) => apiRequestWithMeta<ReconciliationApprovalExecution>(approvalPath(id, ops.reconciliationApprovalExecute), { method: 'POST', headers: json, body: '{}' })

// ---- markets, reliability, access review -------------------------------------------------------------------------------
export const getMarketsSummary = (p: Params = {}) => apiRequest<MarketsSummary>(`${ops.marketsSummary}${opsQuery(p)}`)
export const getReliabilitySummary = (p: Params = {}) => apiRequest<ReliabilitySummary>(`${ops.reliabilitySummary}${opsQuery(p)}`)
export const getAccessReviewSummary = () => apiRequest<AccessReviewSummary>(ops.accessReviewSummary)
export const getAccessReviewUsers = (p: Params = {}) => apiRequest<AccessReviewPage>(`${ops.accessReviewUsers}${opsQuery(p)}`)
