// Admin operations API access. Read-only except reconcile; no mock or fallback data lives here.
import { routes, type AuditEventView, type BookingOperations, type BookingRow, type CancellationRow, type ConnectorRow, type HoldDetail, type HoldRow, type HotelOperationsRow, type LedgerEntryView, type OperationsCapabilities, type OperationsReadiness, type Paged, type ReconcileResponse, type ReconciliationQueue, type SupplierOperationsRow, type WalletRow } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const ops = routes.adminOperations
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const json = { 'Content-Type': 'application/json' }

export const getOpsCapabilities = () => apiRequest<OperationsCapabilities>(ops.capabilities)
export const getOpsReadiness = (p: Params = {}) => apiRequest<OperationsReadiness>(`${ops.readiness}${opsQuery(p)}`)
export const getOpsHotels = (p: Params) => apiRequest<Paged<HotelOperationsRow>>(`${ops.hotels}${opsQuery(p)}`)
export const getOpsSuppliers = (p: Params) => apiRequest<Paged<SupplierOperationsRow>>(`${ops.suppliers}${opsQuery(p)}`)
export const getOpsHolds = (p: Params) => apiRequest<Paged<HoldRow>>(`${ops.holds}${opsQuery(p)}`)
export const getOpsHold = (holdId: string) => apiRequest<HoldDetail>(fill(ops.hold, { holdId }))
export const getOpsBookings = (p: Params) => apiRequest<Paged<BookingRow>>(`${ops.bookings}${opsQuery(p)}`)
export const getOpsBooking = (bookingId: string) => apiRequest<BookingOperations>(fill(ops.booking, { bookingId }))
/** Same-origin URL of an already-issued, immutable document (opened in a new tab; the API never issues one from Admin). */
export const opsDocumentUrl = (bookingId: string, type: 'voucher' | 'invoice' | 'credit-note') => `/api/v1${fill(ops.bookingDocument, { bookingId, type })}`
export const getOpsReconciliation = () => apiRequest<ReconciliationQueue>(ops.reconciliation)
export const runOpsReconciliation = (body: { staleMinutes?: number; prebookMaxMinutes?: number } = {}) => apiRequestWithMeta<ReconcileResponse>(ops.reconcile, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const getOpsCancellations = (p: Params) => apiRequest<Paged<CancellationRow>>(`${ops.cancellations}${opsQuery(p)}`)
export const getOpsWallets = (p: Params) => apiRequest<Paged<WalletRow>>(`${ops.wallets}${opsQuery(p)}`)
export const getOpsLedger = (p: Params) => apiRequest<Paged<LedgerEntryView>>(`${ops.ledger}${opsQuery(p)}`)
export const getOpsAudit = (p: Params) => apiRequest<Paged<AuditEventView>>(`${ops.audit}${opsQuery(p)}`)
export const getOpsConnectors = (p: Params) => apiRequest<Paged<ConnectorRow>>(`${ops.connectors}${opsQuery(p)}`)
