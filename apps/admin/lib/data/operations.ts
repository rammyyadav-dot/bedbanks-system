// Admin operations API access. Read-only except reconcile; no mock or fallback data lives here.
import { routes, type BookingBulkOperationView, type BookingBulkRequest, type BookingSavedViewList, type BookingSavedViewView, type SavedViewUpdateRequest, type SavedViewWriteRequest, type SavedViewWriteResult, type BookingDocumentIssueResult, type BookingFinanceView, type BookingPenaltyRequest, type BookingPenaltyResult, type BookingOperationsPanel, type BookingOpsAcknowledgeRequest, type BookingOpsAnswerRequest, type BookingOpsAssignee, type BookingOpsAssignRequest, type BookingOpsClearRequest, type BookingOpsEscalateRequest, type BookingOpsNoteRequest, type BookingOpsQueuePage, type BookingOpsWriteResult, BOOKING_IDEMPOTENCY_HEADER, type BookingActionRequest, type BookingReferencesRequest, type BookingSupplierRequest, type BookingSupplierResult, type BookingWriteResult, type ManualBookingRequest, type BookingDetailView, type BookingListPage, type AgencyAccountView, type ReceivablesView, type AccessReviewPage, type AccessReviewSummary, type MarketsSummary, type ReliabilitySummary, type ReconciliationApprovalExecution, type ReconciliationApprovalRequest, type ReconciliationApprovalView, type AuditSummary, type FinanceSummary, type AuditEventView, type CancellationRow, type ConnectorRow, type HoldDetail, type HoldRow, type LedgerEntryView, type OperationsCapabilities, type OperationsReadiness, type Paged, type ReconcileResponse, type ReconciliationQueue, type SupplierOperationsRow, type WalletRow } from '@bedbanks/contracts'
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
/**
 * Booking writes (ADR 0039, Phase 2). Each takes the Idempotency-Key the caller generated once per dialog, so a retry after a timeout replays instead of
 * repeating. The API checks permission, status and agency again; nothing here is trusted.
 */
const keyed = (key: string) => ({ ...json, [BOOKING_IDEMPOTENCY_HEADER]: key })
export const postBookingAction = (bookingId: string, body: BookingActionRequest, key: string) => apiRequestWithMeta<BookingWriteResult>(fill(ops.bookingActions, { bookingId }), { method: 'POST', headers: keyed(key), body: JSON.stringify(body) })
export const patchBookingReferences = (bookingId: string, body: BookingReferencesRequest, key: string) => apiRequestWithMeta<BookingWriteResult>(fill(ops.bookingReferences, { bookingId }), { method: 'PATCH', headers: keyed(key), body: JSON.stringify(body) })
export const postBookingSupplier = (bookingId: string, body: BookingSupplierRequest, key: string) => apiRequestWithMeta<BookingSupplierResult>(fill(ops.bookingSupplier, { bookingId }), { method: 'POST', headers: keyed(key), body: JSON.stringify(body) })
export const createManualBooking = (body: ManualBookingRequest, key: string) => apiRequestWithMeta<BookingWriteResult>(ops.bookings, { method: 'POST', headers: keyed(key), body: JSON.stringify(body) })
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

// ---- Operations queue (ADR 0039, Phase 4). Reads never write; every mutation carries the Idempotency-Key the dialog generated once. ----------------------
export const getOpsQueue = (p: Params) => apiRequest<BookingOpsQueuePage>(`${ops.bookingOps}${opsQuery(p)}`)
export const getOpsAssignees = () => apiRequest<BookingOpsAssignee[]>(ops.bookingOpsAssignees)
export const getOpsPanel = (bookingId: string) => apiRequest<BookingOperationsPanel | null>(fill(ops.bookingOpsItem, { bookingId }))
const opsPost = <T>(route: string, bookingId: string, body: unknown, key: string) => apiRequestWithMeta<T>(fill(route, { bookingId }), { method: 'POST', headers: keyed(key), body: JSON.stringify(body) })
export const assignOpsCase = (bookingId: string, body: BookingOpsAssignRequest, key: string) => opsPost<BookingOpsWriteResult>(ops.bookingOpsAssign, bookingId, body, key)
export const acknowledgeOpsCase = (bookingId: string, body: BookingOpsAcknowledgeRequest, key: string) => opsPost<BookingOpsWriteResult>(ops.bookingOpsAcknowledge, bookingId, body, key)
export const escalateOpsCase = (bookingId: string, body: BookingOpsEscalateRequest, key: string) => opsPost<BookingOpsWriteResult>(ops.bookingOpsEscalate, bookingId, body, key)
export const noteOpsCase = (bookingId: string, body: BookingOpsNoteRequest, key: string) => opsPost<BookingOpsWriteResult>(ops.bookingOpsNote, bookingId, body, key)
export const clearOpsCase = (bookingId: string, body: BookingOpsClearRequest, key: string) => opsPost<BookingOpsWriteResult>(ops.bookingOpsClear, bookingId, body, key)
export const answerOpsCase = (bookingId: string, body: BookingOpsAnswerRequest, key: string) => opsPost<BookingOpsWriteResult>(ops.bookingOpsAnswer, bookingId, body, key)

// ---- Money and documents (ADR 0039, Phase 5). Nothing here posts to a ledger; documents are issued once and never edited. -----------------------------------
export const getBookingFinance = (bookingId: string) => apiRequest<BookingFinanceView>(fill(ops.bookingFinance, { bookingId }))
export const postBookingPenalty = (bookingId: string, body: BookingPenaltyRequest, key: string) => apiRequestWithMeta<BookingPenaltyResult>(fill(ops.bookingFinancePenalty, { bookingId }), { method: 'POST', headers: keyed(key), body: JSON.stringify(body) })
export const issueBookingDocument = (bookingId: string, type: string) => apiRequestWithMeta<BookingDocumentIssueResult>(fill(ops.bookingFinanceDocument, { bookingId, type }), { method: 'POST', headers: json, body: '{}' })
/** Same-origin URL of an issued, immutable document page (opened in a new tab). */
export const bookingFinanceDocumentUrl = (bookingId: string, type: string) => `/api/v1${fill(ops.bookingFinanceDocumentHtml, { bookingId, type })}`

// ---- Saved views (ADR 0039, Phase 6B). Personal preferences: the server scopes every call to the signed-in person. -------------------------------------
export const getBookingViews = () => apiRequest<BookingSavedViewList>(ops.bookingViews)
export const getBookingView = (viewId: string) => apiRequest<BookingSavedViewView>(fill(ops.bookingView, { viewId }))
export const createBookingView = (body: SavedViewWriteRequest) => apiRequestWithMeta<SavedViewWriteResult>(ops.bookingViews, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const updateBookingView = (viewId: string, body: SavedViewUpdateRequest) => apiRequestWithMeta<SavedViewWriteResult>(fill(ops.bookingView, { viewId }), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const deleteBookingView = (viewId: string) => apiRequestWithMeta<{ id: string }>(fill(ops.bookingView, { viewId }), { method: 'DELETE', headers: json })
export const setDefaultBookingView = (viewId: string) => apiRequestWithMeta<SavedViewWriteResult>(fill(ops.bookingViewDefault, { viewId }), { method: 'POST', headers: json, body: '{}' })
export const clearDefaultBookingView = () => apiRequestWithMeta<{ cleared: number }>(ops.bookingViewDefaultClear, { method: 'POST', headers: json, body: '{}' })

// ---- Bulk actions (ADR 0039, Phase 6C). Explicit ids only; the key is generated once per confirmation dialog so a retry replays instead of repeating. ----------
export const submitBulkAction = (body: BookingBulkRequest) => apiRequestWithMeta<BookingBulkOperationView>(ops.bookingBulkActions, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const getBulkOperation = (operationId: string) => apiRequest<BookingBulkOperationView>(fill(ops.bookingBulkAction, { operationId }))
