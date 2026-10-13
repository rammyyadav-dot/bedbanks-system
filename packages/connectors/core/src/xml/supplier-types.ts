import { majorUnitsToMinor } from '@bedbanks/money'

/**
 * Canonical, provider-neutral shapes produced at the connector boundary (CLAUDE.md invariant 9).
 * Nothing here is selectable inventory: an observation becomes sellable only after the API maps it through
 * mapping governance, commercial rules and a recheck that supplies a real expiry.
 */
export type SupplierErrorCode =
  | 'disabled' | 'scope' | 'configuration' | 'secret_unavailable' | 'endpoint_rejected'
  | 'authentication' | 'rate_limited' | 'quota_exhausted' | 'timeout' | 'cancelled' | 'transport'
  | 'provider_unavailable' | 'circuit_open' | 'busy'
  | 'malformed_response' | 'supplier_fault' | 'unsupported'

/**
 * Whether the supplier may have acted. `not_sent` is a definite "nothing happened"; `maybe_sent` means a
 * mutation timed out or the connection dropped after the request left, so the caller MUST ask the supplier
 * (status by reference) before concluding anything. Reads are always `not_sent`/`answered`.
 */
export type DeliveryState = 'not_sent' | 'maybe_sent' | 'answered'

export class SupplierCallError extends Error {
  constructor(
    readonly code: SupplierErrorCode,
    readonly delivery: DeliveryState,
    readonly retryAfterMs: number | null = null,
    /** Supplier's own machine code (for example an error number). Never free text, never a payload fragment. */
    readonly supplierCode: string | null = null,
  ) { super(`Supplier call failed (${code})`); this.name = 'SupplierCallError' }
}

export interface SupplierScope { tenantId: string; supplierId: string; connectorId: string }
export interface SupplierCallContext extends SupplierScope { correlationId: string; signal?: AbortSignal }

export interface OccupancyRequest { adults: number; childAges: number[] }
export interface SupplierSearchQuery {
  checkIn: string
  checkOut: string
  /** Supplier destination or hotel codes, resolved from governed mappings by the caller. */
  supplierHotelCodes: string[]
  rooms: OccupancyRequest[]
  /** ISO-4217 currency the supplier is asked to quote in. */
  currency: string
  /** ISO-3166 alpha-2 passenger nationality; some suppliers price by it. */
  nationality?: string
}
export interface CancellationPolicyObservation {
  /** Offset-qualified ISO timestamp. A supplier that sends a bare local time is a malformed response, not a guess. */
  from: string
  penaltyMinor: number
}
export interface SupplierOfferObservation {
  supplierHotelCode: string
  supplierRoomCode: string
  supplierRoomName: string | null
  boardCode: string | null
  roomIndex: number
  checkIn: string
  checkOut: string
  currency: string
  /** Supplier net for the whole stay and room, integer minor units. Not a sell price. */
  netMinor: number
  refundable: boolean | null
  cancellationPolicies: CancellationPolicyObservation[]
  /** null means the supplier did not state it. Treat as a block reason, never as "tax included". */
  taxesIncluded: boolean | null
  /** Opaque token needed to recheck or book. Never logged, never persisted outside the encrypted booking-supplier path. */
  rateToken: string
  /** Supplier-stated validity, or null. Never fabricated. */
  supplierExpiresAt: string | null
  /** Local receipt time; not a supplier timestamp. */
  receivedAt: string
}
export interface SupplierSearchResult { offers: SupplierOfferObservation[] }

export interface SupplierRecheckResult {
  status: 'available' | 'unavailable' | 'price_changed'
  offer: SupplierOfferObservation | null
}
export interface SupplierGuest { title: string | null; firstName: string; lastName: string; isLead: boolean; age: number | null }
export interface SupplierBookRequest {
  /** Our booking reference: the key the supplier can be asked about. */
  reference: string
  /** Caller-owned idempotency key; stable across retries of the same logical booking. */
  idempotencyKey: string
  rateToken: string
  currency: string
  expectedNetMinor: number
  rooms: Array<{ guests: SupplierGuest[] }>
}
export type SupplierBookResult =
  | { outcome: 'CONFIRMED' | 'ON_REQUEST'; supplierRef: string | null; hotelConfirmationNo: string | null }
  | { outcome: 'REJECTED'; code: string }
export type SupplierCancelResult =
  | { outcome: 'CANCELLED'; supplierCancellationRef: string | null; penaltyMinor: number | null }
  | { outcome: 'REJECTED'; code: string }
export type SupplierStatusResult =
  | { found: false }
  | { found: true; state: 'CONFIRMED' | 'ON_REQUEST' | 'CANCELLED' | 'REJECTED'; supplierRef: string | null; hotelConfirmationNo: string | null; supplierCancellationRef: string | null }

/** Decimal string -> integer minor units through BigInt. Floats, signs, exponents, empty and zero values are refused. */
export function supplierAmountMinor(value: string | number | undefined | null, currency: string, allowZero = false): number {
  if (typeof value !== 'string') throw new SupplierCallError('malformed_response', 'answered')
  let minor: number
  try { minor = majorUnitsToMinor(value, currency) } catch { throw new SupplierCallError('malformed_response', 'answered') }
  if (minor === 0 && !allowZero) throw new SupplierCallError('malformed_response', 'answered')
  return minor
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
export function isOffsetTimestamp(value: unknown): value is string { return typeof value === 'string' && OFFSET_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)) }

export function validateSearchQuery(query: SupplierSearchQuery): void {
  const ok = isIsoDate(query.checkIn) && isIsoDate(query.checkOut) && query.checkOut > query.checkIn &&
    Array.isArray(query.supplierHotelCodes) && query.supplierHotelCodes.length >= 1 && query.supplierHotelCodes.length <= 200 &&
    query.supplierHotelCodes.every((c) => /^[A-Za-z0-9_.:-]{1,64}$/.test(c)) &&
    Array.isArray(query.rooms) && query.rooms.length >= 1 && query.rooms.length <= 9 &&
    query.rooms.every((r) => Number.isInteger(r.adults) && r.adults >= 1 && r.adults <= 8 && Array.isArray(r.childAges) && r.childAges.length <= 6 && r.childAges.every((a) => Number.isInteger(a) && a >= 0 && a <= 17)) &&
    /^[A-Z]{3}$/.test(query.currency) && (query.nationality === undefined || /^[A-Z]{2}$/.test(query.nationality))
  if (!ok) throw new SupplierCallError('unsupported', 'not_sent')
}
