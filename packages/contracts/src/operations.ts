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
import type { AgencyOverdueView, DepartmentPermission } from './departments'
export interface OperationsCapabilities { permissions: Array<OperationsPermission | DepartmentPermission> }

/** Machine-readable error codes the Admin branches on (in addition to the generic HTTP-status codes). */
export const OPERATIONS_READ_DENIED = 'OPERATIONS_READ_DENIED'
/** HTTP 503: a mandatory commercial control (agency suspension, distribution restriction, markup rule) could not be read, so the request was refused rather than served unrestricted (ADR 0031). */
export const COMMERCIAL_CONTROL_UNAVAILABLE = 'COMMERCIAL_CONTROL_UNAVAILABLE'
/** HTTP 503: an authorized operation needs a database privilege the API runtime role does not hold. Infrastructure configuration, never a caller authorization decision (ADR 0031). */
export const DATABASE_ROLE_NOT_PERMITTED = 'DATABASE_ROLE_NOT_PERMITTED'
/** HTTP 403: an authorized caller asked for an operation that the API runtime database role is, by contract, never given (a privileged path). Typed, audited, nothing written (ADR 0032). */
export const RUNTIME_ROLE_OPERATION_PROHIBITED = 'RUNTIME_ROLE_OPERATION_PROHIBITED'

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
/** The ten-value booking lifecycle (ADR 0039). `Closed` is a lock (`closedAt`), not a status. */
export const BOOKING_STATUSES = ['PENDING_SUPPLIER', 'ON_REQUEST', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CANCELLED', 'CHECKED_OUT', 'NO_SHOW', 'REJECTED', 'FAILED'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]
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
    /** Durable supplier reference from the mutation journal, when the mutation was acknowledged. */
    supplierBookingReference: string | null
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
/** Maker-checker for a reconciliation run (ADR 0017). The approved parameters are the only ones the run may use. */
export type ApprovalStatusName = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXECUTED'
export interface ReconciliationApprovalView {
  id: string
  status: ApprovalStatusName
  requestedById: string
  reason: string
  parameters: { staleMinutes: number | null; prebookMaxMinutes: number | null }
  /** Stalled holds the queue showed when the request was made. Evidence for the approver, not a promise. */
  stalledHoldsAtRequest: number | null
  decidedById: string | null
  decisionReason: string | null
  decidedAt: string | null
  executedById: string | null
  executedAt: string | null
  createdAt: string
  /** True when the caller is not the requester, so may approve or reject. The server enforces this regardless. */
  canDecide: boolean
  /** True for the requester while the request is pending. */
  canCancel: boolean
  /** True once approved and not yet used. Anyone holding booking.reconcile may run it, once. */
  canExecute: boolean
}
export interface ReconciliationApprovalRequest { requestId: string; reason: string; staleMinutes?: number; prebookMaxMinutes?: number }
export interface ReconciliationApprovalDecision { reason: string }
export interface ReconciliationApprovalExecution { approval: ReconciliationApprovalView; result: ReconcileResponse }
export interface ReconcileResponse { dryRun: false; examined: number; items: Array<{ holdId: string; bookingId: string | null; outcome: string }> }

// ---- Cancellations ---------------------------------------------------------------------------------------------------
export interface CancellationRow {
  bookingId: string; reference: string; bookingStatus: BookingStatus; hotelName: string | null; checkIn: string | null
  currency: string; totalMinor: MinorString; reason: string | null; refundMinor: MinorString | null; refundPosted: MinorString | null; refundMatches: boolean; createdAt: string
}

// ---- Finance ---------------------------------------------------------------------------------------------------------
/** Who an account belongs to (ADR 0028): the tenant's HOUSE account (the one holds and bookings post to today) or one AGENCY. */
export type AccountOwner = 'HOUSE' | 'AGENCY'
export const ACCOUNT_OWNERS: readonly AccountOwner[] = ['HOUSE', 'AGENCY']
export interface AccountAgencyRef { id: string; code: string; name: string }
export interface WalletRow {
  id: string; tenantId: string; owner: AccountOwner; agency: AccountAgencyRef | null
  currency: string; creditLimit: MinorString; balanceMinor: MinorString; availableCreditMinor: MinorString
  /** The ledger is the only authority. `Wallet.cached_balance` is not maintained by any code path and is deliberately not shown. */
  entryCount: number; updatedAt: string
}
export interface LedgerQuery { walletId?: string; type?: string; bookingId?: string; from?: string; to?: string; page?: number; pageSize?: number }
export interface WalletQuery { owner?: AccountOwner; agencyId?: string; page?: number; pageSize?: number }

/**
 * One agency's account position (ADR 0028 slice 1, read-only). An account is NOT_OPENED until its first funding is posted (slice 2);
 * a not-opened account holds no money, so its balance is exactly zero. `bookingsPostTo` stays HOUSE until slice 3 moves holds here.
 */
export interface AgencyAccountPosition {
  currency: string; status: 'OPEN' | 'NOT_OPENED'; accountId: string | null
  balanceMinor: MinorString; entryCount: number; lastEntryAt: string | null
  /** Latest entries, newest first (at most 25). The full statement is `ledger?walletId=accountId`. */
  recent: LedgerEntryView[]
}
/** One agency account with unpaid settled charges (ADR 0028 slice 4), oldest first. */
export interface ReceivableRow {
  accountId: string; agency: AccountAgencyRef & { status: string }; currency: string; balanceMinor: MinorString
  overdue: AgencyOverdueView
}
export interface ReceivablesView { items: ReceivableRow[]; counts: { notice: number; holdsRefused: number }; noticeDays: number; refuseHoldsAfterDays: number }
export interface AgencyAccountView {
  agency: AccountAgencyRef & { status: string }
  accounts: AgencyAccountPosition[]
  fundingEnabled: false
  bookingsPostTo: 'HOUSE'
}

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

// ---- Finance and audit summaries ---------------------------------------------------------------------------------------
export type LedgerEntryType = 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND'
/** Trailing window of whole UTC days ending today. */
export const SUMMARY_WINDOW_DEFAULT_DAYS = 30
export const SUMMARY_WINDOW_MAX_DAYS = 90
export interface SummaryWindow { from: string; to: string; days: number }

/**
 * Per-currency finance position. Currencies are never added together. Money is an integer minor-unit string.
 * Balance and available credit use the finance service's formula: balance = SUM(all ledger entries), available = credit limit + balance.
 */
export interface FinanceCurrencySummary {
  currency: string
  wallets: number
  creditLimitMinor: MinorString
  balanceMinor: MinorString
  availableCreditMinor: MinorString
  /** Wallets whose available credit is below zero. Should be 0; anything else needs a finance investigation. */
  overdrawnWallets: number
}
export interface LedgerWindowSummary {
  entries: number
  /** Per currency and entry type, the sum of stored signed amounts in the window. */
  byCurrency: Array<{ currency: string; entries: number; netMinor: MinorString; byType: Array<{ type: LedgerEntryType; entries: number; sumMinor: MinorString }> }>
}
export interface FinanceSummary {
  generatedAt: string
  window: SummaryWindow
  definitions: Record<string, string>
  wallets: SectionState<{ total: number; currencies: FinanceCurrencySummary[] }>
  ledger: SectionState<LedgerWindowSummary>
}

export interface AuditSummary {
  generatedAt: string
  window: SummaryWindow
  definitions: Record<string, string>
  events: SectionState<{
    total: number
    lastEventAt: string | null
    byActorType: Array<{ actorType: string; events: number }>
    /** Events grouped by the first dot-separated segment of the action (booking, supplier, approval ...). */
    byDomain: Array<{ domain: string; events: number }>
    /** Events that record a refusal or an uncertain outcome and deserve a look. */
    attention: { denied: number; unknownSupplierOutcomes: number; selfApprovalAttempts: number }
  }>
}

// ---- Markets, reliability and access review (ADR 0017) -----------------------------------------------------------------
export interface MarketDestinationRow {
  countryCode: string; city: string; hotels: number
  ready: number; partial: number; blocked: number
  mappingIssues: number; rateGaps: number; availabilityGaps: number; contractsExpiring: number
}
export interface MarketsSummary {
  generatedAt: string
  window: SummaryWindow
  scanCapped: boolean
  totalHotels: number
  /** Sorted by hotel count, then name. Readiness uses the same evaluator as Agent search. */
  destinations: MarketDestinationRow[]
  definitions: Record<string, string>
}

export interface ReliabilitySummary {
  generatedAt: string
  window: SummaryWindow
  definitions: Record<string, string>
  connectors: SectionState<{ total: number; enabled: number; unhealthy: number; unknown: number }>
  /** Connector executions created in the window. Counts only: no rates are computed, so nothing is rounded. */
  executions: SectionState<{ total: number; succeeded: number; failed: number; retrying: number; byClassification: Array<{ classification: string; count: number }> }>
  /** Supplier calls whose outcome is not known (sending or unknown). They may have reached the supplier. */
  supplierOutcomes: SectionState<{ uncertain: number; oldestUncertainAt: string | null }>
  holds: SectionState<{ stalledProcessing: number; staleMinutes: number }>
}

export type AccessFlag = 'INACTIVE' | 'NEVER_LOGGED_IN' | 'STALE_LOGIN' | 'NO_ROLE' | 'HOLDS_SENSITIVE'
export interface AccessReviewSummary {
  generatedAt: string
  staleLoginDays: number
  definitions: Record<string, string>
  members: { total: number; active: number; inactive: number; neverLoggedIn: number; staleLogin: number; noRole: number; holdingSensitive: number }
  roles: Array<{ id: string; name: string; members: number; sensitivePermissions: string[] }>
}
export interface AccessReviewUserRow {
  userId: string; email: string; name: string | null; status: string; membershipRole: string
  roles: string[]; sensitivePermissions: string[]; lastLoginAt: string | null; flags: AccessFlag[]
}
export interface AccessReviewPage { items: AccessReviewUserRow[]; page: number; pageSize: number; total: number }
