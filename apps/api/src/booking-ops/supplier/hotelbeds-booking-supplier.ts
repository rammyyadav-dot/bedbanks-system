import { SandboxError, buildHotelbedsBookBody, findHotelbedsBooking, hotelbedsClientReference, normalizeHotelbedsBooking, type HotelbedsBookBody, type HotelbedsBookingInputs, type SandboxContext } from '@bedbanks/connectors-core'
import {
  BookingSupplierCallError, type BookingSupplierBookRequest, type BookingSupplierBookResult, type BookingSupplierCancelResult, type BookingSupplierContext, type BookingSupplierPort, type BookingSupplierStatus,
} from './booking-supplier.port'

/**
 * Adapts the Hotelbeds SANDBOX transport to the Admin booking queue port (CLAUDE.md invariant 9: Hotelbeds wire shapes stay in `@bedbanks/connectors-core`).
 *
 * Not wired into `BookingSupplierRegistry` by default. It is built only when an operator supplies a configured transport (`bookingEnabled: true`) and a
 * `HotelbedsBookingInputsResolver`; the hosts are the Hotelbeds TEST hosts only, so nothing here can reach live inventory.
 *  - A definite supplier refusal (HTTP 4xx) becomes REJECTED. Every other failure THROWS, because the runner treats a throw as "we do not know" and asks
 *    `statusByReference` before it may call a booking failed (no ghost bookings, no duplicates).
 *  - The supplier has no idempotency key, so the booking is keyed by `clientReference` (derived from our `FB-` reference) and looked up by it.
 *  - The port carries no guest data and no rate key: the resolver supplies both from the audited booking store. Nothing here logs either.
 *  - The booked price must equal the expected supplier net exactly (`tolerance: 0` is sent too). A mismatch is never reported as a clean confirmation.
 */
export interface HotelbedsBookingInputsResolver { resolve(context: BookingSupplierContext, request: BookingSupplierBookRequest): Promise<HotelbedsBookingInputs & { expectedNetMinor: number }> }
/** The slice of HotelbedsSandboxTransport this adapter uses, so tests and wiring do not depend on transport details. */
export interface HotelbedsBookingTransport {
  book(body: HotelbedsBookBody, context: SandboxContext): Promise<unknown>
  cancelBooking(bookingReference: string, context: SandboxContext): Promise<unknown>
  findBookings(clientReference: string, start: string, end: string, context: SandboxContext): Promise<unknown>
}
export interface HotelbedsBookingScope { supplierId: string; connectorId: string }

/** How far back a lookup by reference looks. The runner asks within minutes of the call, so a month is a wide margin, not a promise about old bookings. */
const LOOKUP_DAYS = 30

export class HotelbedsBookingSupplier implements BookingSupplierPort {
  constructor(readonly key: string, private readonly transport: HotelbedsBookingTransport, private readonly scope: HotelbedsBookingScope, private readonly inputs: HotelbedsBookingInputsResolver, private readonly now: () => Date = () => new Date()) {}

  private context(context: BookingSupplierContext): SandboxContext {
    return { tenantId: context.tenantId, supplierId: this.scope.supplierId, connectorId: this.scope.connectorId, correlationId: context.requestId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100) || 'none' }
  }

  /** `unsupported` is the transport's word for a 4xx answer or a refused request: a definite no. Everything else is operational and throws. */
  private classify(error: unknown): { refused: true; code: string } | never {
    if (!(error instanceof SandboxError)) throw new BookingSupplierCallError('error', 'UNCLASSIFIED')
    if (error.code === 'unsupported') return { refused: true, code: 'HOTELBEDS_REFUSED' }
    const kind = error.code === 'timeout' ? 'timeout' : ['transport', 'provider_unavailable', 'circuit_open', 'rate_limited', 'busy'].includes(error.code) ? 'transport' : 'error'
    throw new BookingSupplierCallError(kind, error.code.toUpperCase())
  }

  async book(context: BookingSupplierContext, request: BookingSupplierBookRequest): Promise<BookingSupplierBookResult> {
    let resolved: Awaited<ReturnType<HotelbedsBookingInputsResolver['resolve']>>
    try { resolved = await this.inputs.resolve(context, request) } catch { throw new BookingSupplierCallError('error', 'BOOK_INPUTS_UNAVAILABLE') }
    const adults = resolved.guests.filter(g => g.type === 'AD').length; const children = resolved.guests.filter(g => g.type === 'CH').length
    // Local checks: nothing has been sent, so these are definite refusals and cannot hide a booking.
    if (request.currency !== 'AED') return { outcome: 'REJECTED', code: 'UNSUPPORTED_CURRENCY' }
    if (request.rooms.length !== 1 || request.rooms[0].adults !== adults || request.rooms[0].children !== children) return { outcome: 'REJECTED', code: 'GUEST_COUNT_MISMATCH' }
    if (!Number.isSafeInteger(resolved.expectedNetMinor) || resolved.expectedNetMinor <= 0) return { outcome: 'REJECTED', code: 'INVALID_EXPECTED_NET' }
    let body: HotelbedsBookBody
    try { body = buildHotelbedsBookBody(request.reference, resolved) } catch { return { outcome: 'REJECTED', code: 'INVALID_BOOKING_REQUEST' } }
    let payload: unknown
    try { payload = await this.transport.book(body, this.context(context)) } catch (error) {
      const refusal = this.classify(error); return { outcome: 'REJECTED', code: refusal.code }
    }
    let facts: ReturnType<typeof normalizeHotelbedsBooking>
    try { facts = normalizeHotelbedsBooking(payload) } catch { throw new BookingSupplierCallError('error', 'MALFORMED_RESPONSE') }
    // The supplier answered but not with the booking we asked for. It may well hold one, so this is "unknown", never a clean confirmation or a failure.
    if (facts.clientReference !== body.clientReference) throw new BookingSupplierCallError('error', 'REFERENCE_MISMATCH')
    if (facts.state !== 'CONFIRMED') throw new BookingSupplierCallError('error', 'UNEXPECTED_STATE')
    if (facts.totalNetMinor !== resolved.expectedNetMinor) throw new BookingSupplierCallError('error', 'PRICE_MISMATCH')
    return { outcome: 'CONFIRMED', supplierRef: facts.supplierRef, hotelConfirmationNo: null }
  }

  async cancel(context: BookingSupplierContext, request: { reference: string; supplierKey: string; supplierRef: string | null }): Promise<BookingSupplierCancelResult> {
    let supplierRef = request.supplierRef
    if (!supplierRef) {
      const seen = await this.statusByReference(context, request)
      if (!seen.found || !seen.supplierRef) return { outcome: 'REJECTED', code: 'BOOKING_NOT_FOUND' }
      if (seen.state === 'CANCELLED') return { outcome: 'CANCELLED', supplierCancellationRef: null } // already cancelled: a retried cancel is idempotent
      supplierRef = seen.supplierRef
    }
    let payload: unknown
    try { payload = await this.transport.cancelBooking(supplierRef, this.context(context)) } catch (error) {
      const refusal = this.classify(error); return { outcome: 'REJECTED', code: refusal.code }
    }
    let facts: ReturnType<typeof normalizeHotelbedsBooking>
    try { facts = normalizeHotelbedsBooking(payload) } catch { throw new BookingSupplierCallError('error', 'MALFORMED_RESPONSE') }
    if (facts.supplierRef !== supplierRef || facts.state !== 'CANCELLED') throw new BookingSupplierCallError('error', 'UNEXPECTED_STATE')
    return { outcome: 'CANCELLED', supplierCancellationRef: null }
  }

  async statusByReference(context: BookingSupplierContext, request: { reference: string; supplierKey: string }): Promise<BookingSupplierStatus> {
    let clientReference: string
    try { clientReference = hotelbedsClientReference(request.reference) } catch { throw new BookingSupplierCallError('error', 'INVALID_REFERENCE') }
    const end = this.now(); const start = new Date(end.getTime() - LOOKUP_DAYS * 86_400_000)
    let payload: unknown
    try { payload = await this.transport.findBookings(clientReference, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), this.context(context)) } catch (error) {
      this.classify(error); throw new BookingSupplierCallError('error', 'STATUS_REFUSED') // a refusal to answer is not "nothing held"
    }
    let found: ReturnType<typeof findHotelbedsBooking>
    try { found = findHotelbedsBooking(payload, clientReference) } catch { throw new BookingSupplierCallError('error', 'MALFORMED_RESPONSE') }
    return found ? { found: true, state: found.state, supplierRef: found.supplierRef, hotelConfirmationNo: null, supplierCancellationRef: null } : { found: false }
  }
}
