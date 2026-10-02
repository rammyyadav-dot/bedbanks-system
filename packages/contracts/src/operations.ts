/**
 * Contracts for the read-only Admin operations API (`/admin/operations/*`).
 * Money is always an integer minor-unit string plus an ISO-4217 currency; the Admin formats it for display only.
 * Every list is server-paginated. A privilege boundary on the API's database role is reported as the
 * `OPERATIONS_READ_DENIED` error code (HTTP 503), never as an empty list.
 */

export const operationsPermissions = {
  bookingsRead: 'booking.read',
  bookingsReconcile: 'booking.reconcile',
  bookingsCancel: 'booking.cancel',
  financeRead: 'finance.read',
  auditRead: 'audit.read',
} as const
export type OperationsPermission = (typeof operationsPermissions)[keyof typeof operationsPermissions]
export interface OperationsCapabilities { permissions: OperationsPermission[] }

/** Machine-readable error codes the Admin branches on (in addition to the generic HTTP-status codes). */
export const OPERATIONS_READ_DENIED = 'OPERATIONS_READ_DENIED'

export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number }
export type MinorString = string

// ---- Hotels, suppliers, readiness -------------------------------------------------------------------------------
// Hotel commercial rows, queries and readiness live in ./hotel-commercial.

export interface SupplierOperationsRow {
  id: string; displayName: string; legalName: string; type: string; status: string; countryCode: string; defaultCurrency: string
  hotelMappings: { total: number; mapped: number; pending: number; rejected: number }
  roomMappings: { total: number; mapped: number; pending: number; rejected: number }
  contracts: { total: number; active: number }
  createdAt: string; updatedAt: string
}

export type SectionState<T> = { state: 'available'; data: T } | { state: 'unavailable'; reason: typeof OPERATIONS_READ_DENIED }
export interface OperationsReadiness {
  generatedAt: string
  window: { from: string; to: string; days: number }
  /** Definitions in plain words, so every number on the dashboard can be audited. */
  definitions: Record<string, string>
  supply: SectionState<{
    suppliers: { total: number; active: number }
    hotels: { total: number; ready: number; partial: number; blocked: number }
    hotelMappings: { mapped: number; pending: number; rejected: number }
    roomMappings: { mapped: number; pending: number; rejected: number }
    rateGapHotels: number; availabilityGapHotels: number; stopSellHotels: number; contractsExpiring: number
  }>
  transactions: SectionState<{
    holds: { held: number; processing: number; total: number }
    bookings: { pending: number; confirmed: number; failed: number; cancelled: number; total: number }
    reconciliationRequired: number
    cancellationsMissingRefund: number
  }>
  connectors: SectionState<{ total: number; enabled: number; unhealthy: number; unknown: number }>
}

// ---- Inventory holds -----------------------------------------------------------------------------------------------
export type InventoryHoldStatus = 'PENDING_RECHECK' | 'RECHECKED' | 'HOLD_PENDING' | 'HELD' | 'PROCESSING' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED' | 'FAILED'
export interface HoldRow {
  id: string; tenantId: string; status: InventoryHoldStatus; hotelId: string; hotelName: string | null; roomTypeId: string; roomName: string | null
  checkIn: string; checkOut: string; rooms: number; currency: string; sellAmountMinor: MinorString
  createdAt: string; expiresAt: string; releasedAt: string | null; requestId: string
  booking: { id: string; reference: string; status: string } | null
}
export interface HoldNightView { stayDate: string; quantity: number; allotment: number | null; sold: number | null; held: number | null; remaining: number | null; stopSell: boolean | null }
export interface HoldDetail extends HoldRow { offerId: string; searchId: string; ratePlanId: string; boardBasisId: string; nights: HoldNightView[]; audit: AuditEventView[] }
export interface HoldsQuery { status?: InventoryHoldStatus; hotelId?: string; from?: string; to?: string; page?: number; pageSize?: number }

// ---- Bookings --------------------------------------------------------------------------------------------------------
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED'
/**
 * Server-evaluated consistency flags. Documents are issued lazily on first view, so an absent document is never a flag.
 * A flag is evidence to investigate, not an automatic verdict; nothing here changes booking state.
 */
export type BookingAttention = 'RECONCILIATION_REQUIRED' | 'PREBOOK_EXPIRED_UNRESOLVED' | 'FINANCIAL_MISMATCH' | 'INVENTORY_MISMATCH' | 'INVENTORY_NOT_RELEASED' | 'REFUND_MISSING' | 'CANCELLATION_RECORD_MISSING'
export interface BookingRow {
  id: string; reference: string; status: BookingStatus; tenantId: string; supplier: string
  hotelId: string; hotelName: string | null; roomName: string | null; checkIn: string | null; checkOut: string | null
  currency: string; totalMinor: MinorString; createdAt: string; holdId: string | null; attention: BookingAttention[]
}
export interface BookingsQuery { status?: BookingStatus; reference?: string; hotelId?: string; supplier?: string; createdFrom?: string; createdTo?: string; checkInFrom?: string; checkInTo?: string; attention?: boolean; page?: number; pageSize?: number }
export interface LedgerEntryView { id: string; walletId: string; type: string; amountMinor: MinorString; currency: string; reference: string | null; idempotencyKey: string; at: string; bookingId: string | null }
export interface BookingDocumentView { type: 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE'; number: string; issuedAt: string }
export interface AuditEventView { id: string; at: string; action: string; entityType: string; entityId: string; actorType: string; userId: string | null; requestId: string | null; correlationId: string | null; payload: Record<string, unknown> }
export interface BookingOperations {
  booking: { id: string; reference: string; status: BookingStatus; createdAt: string; updatedAt: string; tenantId: string; createdByRequestId: string | null }
  stay: { hotelId: string; hotelName: string | null; roomTypeId: string | null; roomName: string | null; boardBasisId: string | null; boardCode: string | null; checkIn: string | null; checkOut: string | null; rooms: number | null; adults: number | null; children: number | null }
  commercial: { currency: string; totalMinor: MinorString; offerId: string | null; searchId: string | null; ratePlanId: string | null; snapshotVersion: number | null }
  inventory: { holdId: string | null; hold: { status: InventoryHoldStatus; expiresAt: string; releasedAt: string | null; rooms: number; nights: HoldNightView[] } | null }
  supplier: {
    supplier: string
    /** Not persisted on the Booking record: shown as null rather than inferred. */
    supplierBookingReference: null
    prebook: { at: string; requestId: string | null } | null
    confirmation: { at: string; requestId: string | null } | null
  }
  finance: { entries: LedgerEntryView[]; netMinor: MinorString }
  /** Issued documents only. Documents are issued on first view, so a missing one is not an error. */
  documents: BookingDocumentView[]
  issuableDocuments: Array<'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE'>
  cancellation: { record: { reason: string | null; refundMinor: MinorString | null; createdAt: string } | null; refundPosted: MinorString | null }
  attention: BookingAttention[]
  audit: AuditEventView[]
}

// ---- Reconciliation --------------------------------------------------------------------------------------------------
export interface ReconciliationCase {
  source: 'reconciliation_dry_run' | 'consistency_check'
  kind: string
  bookingId: string | null; bookingReference: string | null; bookingStatus: string | null
  holdId: string | null; holdStatus: string | null
  detail: string; observedAt: string
}
export interface ReconciliationQueue { generatedAt: string; staleMinutes: number; total: number; cases: ReconciliationCase[] }
export interface ReconcileRequest { staleMinutes?: number; prebookMaxMinutes?: number }
export interface ReconcileResponse { dryRun: false; examined: number; items: Array<{ holdId: string; bookingId: string | null; outcome: string }> }

// ---- Cancellations ---------------------------------------------------------------------------------------------------
export interface CancellationRow {
  bookingId: string; reference: string; bookingStatus: BookingStatus; hotelName: string | null; checkIn: string | null
  currency: string; totalMinor: MinorString; reason: string | null; refundMinor: MinorString | null; refundPosted: MinorString | null; refundMatches: boolean; createdAt: string
}

// ---- Finance ---------------------------------------------------------------------------------------------------------
export interface WalletRow {
  id: string; tenantId: string; currency: string; creditLimit: MinorString; balanceMinor: MinorString; availableCreditMinor: MinorString
  /** The ledger is the only authority. `Wallet.cached_balance` is not maintained by any code path and is deliberately not shown. */
  entryCount: number; updatedAt: string
}
export interface LedgerQuery { walletId?: string; type?: string; bookingId?: string; from?: string; to?: string; page?: number; pageSize?: number }

// ---- Audit -----------------------------------------------------------------------------------------------------------
export interface AuditQuery { requestId?: string; correlationId?: string; action?: string; entityType?: string; entityId?: string; userId?: string; from?: string; to?: string; page?: number; pageSize?: number }

// ---- Connectors ------------------------------------------------------------------------------------------------------
export interface ConnectorRow {
  id: string; name: string; type: string; status: string; healthState: string; version: string
  supplier: { id: string; displayName: string }
  capabilityCount: number
  /** Presence only. The reference value is never returned, and nothing here proves a secret is valid. */
  credentials: Array<{ purpose: string; status: 'configured' | 'missing' }>
  lastExecution: ConnectorExecutionView | null; lastSuccess: ConnectorExecutionView | null; lastFailure: ConnectorExecutionView | null
}
export interface ConnectorExecutionView { operation: string; status: string; latencyMs: number | null; errorClassification: string | null; at: string }
