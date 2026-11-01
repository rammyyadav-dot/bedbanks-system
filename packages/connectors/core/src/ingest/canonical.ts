/**
 * Canonical records produced by supplier/channel-manager ingestion (CLAUDE.md invariants 3, 5, 9).
 * These are *observations*: nothing here is sellable until the API maps hotel/room/plan identity through governed
 * mappings and applies commercial rules. Provider field names never appear here.
 */
export type IngestRecordKind = 'rate' | 'allotment' | 'cancellation'

export type IngestRejectCode =
  | 'missing_field' | 'invalid_date' | 'invalid_amount' | 'invalid_currency' | 'invalid_integer' | 'invalid_code'
  | 'invalid_flag' | 'invalid_policy' | 'invalid_range' | 'duplicate_conflict' | 'unsupported_shape'

export interface IngestReject {
  kind: IngestRecordKind
  /** Position in the extracted record list. Never a payload fragment (invariant 7). */
  index: number
  code: IngestRejectCode
  /** Canonical field name, not supplier content. */
  field: string | null
}

export interface IngestRate {
  supplierHotelCode: string
  supplierRoomCode: string
  supplierRatePlanCode: string
  boardCode: string | null
  /** The night this price applies to (the night that starts on this date). */
  stayDate: string
  currency: string
  /** Supplier net for one night and room, integer minor units, strictly positive (ADR 0034). */
  netMinor: number
  /** null = supplier did not say; a block reason downstream, never "included". */
  taxesIncluded: boolean | null
  minStay: number | null
  maxStay: number | null
  closedToArrival: boolean
  closedToDeparture: boolean
}

export type IngestInventoryMode = 'ALLOTMENT' | 'FREE_SALE' | 'ON_REQUEST' | 'CLOSED'

export interface IngestAllotment {
  supplierHotelCode: string
  supplierRoomCode: string
  supplierRatePlanCode: string | null
  stayDate: string
  mode: IngestInventoryMode
  /** Units for ALLOTMENT; null for every other mode. A missing count is rejected, never read as zero or unlimited. */
  available: number | null
  stopSell: boolean
  releaseDays: number | null
}

export type CancellationPenalty =
  | { type: 'FIXED'; amountMinor: number; currency: string }
  | { type: 'PERCENT'; basisPoints: number }
  | { type: 'NIGHTS'; nights: number }
  | { type: 'FULL' }

export interface CancellationWindow {
  /** Offset-qualified ISO instant from which `penalty` applies, until the next window starts. */
  from: string
  penalty: CancellationPenalty
}

export interface IngestCancellationPolicy {
  supplierHotelCode: string
  supplierRoomCode: string | null
  supplierRatePlanCode: string
  nonRefundable: boolean
  /** Sorted by `from`, strictly increasing. Before the first window the stay is free to cancel. */
  windows: CancellationWindow[]
}

export type IngestStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED'

export interface IngestResult<T> {
  accepted: T[]
  rejected: IngestReject[]
  /** Records extracted before validation. 0 extracted is FAILED: an empty feed is not "everything closed". */
  extracted: number
  /**
   * COMPLETE: every record accepted. PARTIAL: some rejected. FAILED: nothing accepted or the reject ratio exceeded
   * the caller's limit. Callers must not replace existing inventory from a PARTIAL or FAILED result.
   */
  status: IngestStatus
}
