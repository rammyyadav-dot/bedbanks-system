/**
 * The supplier side of the Admin booking queue (ADR 0039, Phase 3). Transport-agnostic: provider-specific types stay inside the adapter that implements
 * this port and are mapped to these canonical shapes at the boundary (CLAUDE.md invariant 9). The runner never sees a supplier payload and nothing here
 * carries guest personal data: an adapter that needs guest names must read them itself, under its own audit, when the first real supplier is added.
 *
 * Calls either return a definite answer or throw `BookingSupplierCallError`. A throw means "we do not know whether the supplier acted": the runner
 * must then ask `statusByReference` before it ever concludes the booking failed (no ghost bookings).
 */
export interface BookingSupplierContext { tenantId: string; requestId: string }
export interface BookingSupplierBookRequest {
  /** Our `FB-` reference: the key the supplier can be asked about later. */
  reference: string
  supplierKey: string
  checkIn: string | null
  checkOut: string | null
  currency: string
  /** Integer minor units. */
  sellMinor: bigint
  rooms: Array<{ roomName: string | null; boardCode: string | null; adults: number; children: number; childAges: number[] }>
}
export type BookingSupplierBookResult =
  | { outcome: 'CONFIRMED' | 'ON_REQUEST'; supplierRef: string | null; hotelConfirmationNo: string | null }
  | { outcome: 'REJECTED'; code: string }
export type BookingSupplierCancelResult =
  | { outcome: 'CANCELLED'; supplierCancellationRef: string | null }
  | { outcome: 'REJECTED'; code: string }
export type BookingSupplierStatus =
  | { found: false }
  | { found: true; state: 'CONFIRMED' | 'ON_REQUEST' | 'CANCELLED' | 'REJECTED'; supplierRef: string | null; hotelConfirmationNo: string | null; supplierCancellationRef?: string | null }

export interface BookingSupplierPort {
  readonly key: string
  book(context: BookingSupplierContext, request: BookingSupplierBookRequest): Promise<BookingSupplierBookResult>
  cancel(context: BookingSupplierContext, request: { reference: string; supplierKey: string; supplierRef: string | null }): Promise<BookingSupplierCancelResult>
  /** Ask the supplier what it holds under our reference. The only way to tell "never booked" from "booked but we never heard". */
  statusByReference(context: BookingSupplierContext, request: { reference: string; supplierKey: string }): Promise<BookingSupplierStatus>
}

export type BookingSupplierFailureKind = 'timeout' | 'transport' | 'error'
export class BookingSupplierCallError extends Error {
  constructor(readonly kind: BookingSupplierFailureKind, readonly code: string, readonly httpStatus?: number) { super(`Supplier call failed (${kind})`); this.name = 'BookingSupplierCallError' }
}

/** Resolves the adapter for a supplier key and tenant, or null when none is configured. Null is an honest "not configured", never a stand-in. */
export interface BookingSupplierResolver { resolve(tenantId: string, supplierKey: string): BookingSupplierPort | null }
export const BOOKING_SUPPLIER_RESOLVER = Symbol('BOOKING_SUPPLIER_RESOLVER')
