import { BookingSupplierCallError, type BookingSupplierBookRequest, type BookingSupplierBookResult, type BookingSupplierCancelResult, type BookingSupplierContext, type BookingSupplierPort, type BookingSupplierStatus } from './booking-supplier.port'

/**
 * A scripted supplier for development, staging and tests ONLY (ADR 0039, decision 4). It is never a default and never reachable for a real tenant: the
 * registry exposes it only when `ALLOW_MOCK_SUPPLIER=true` AND the tenant is listed in `MOCK_SUPPLIER_TENANT_IDS`. Behaviour is chosen by the supplier key
 * of the booking, so a person can rehearse every outcome from the Admin by entering a manual booking with that supplier name:
 *
 *   mock-confirm        confirmed, with supplier reference and hotel confirmation number
 *   mock-confirm-noref  confirmed with NO references (exercises the "missing supplier ref" flag)
 *   mock-on-request     answers "on request"; later `mock-on-request-confirm` style answers come from a status check
 *   mock-reject         definite rejection (no availability)
 *   mock-timeout        the call times out and the supplier did NOT book (retries, then Failed)
 *   mock-ghost          the call times out but the supplier DID book (the status check must find it: no ghost, no duplicate)
 *   mock-ghost-late     booked, the call times out, and the first status check also fails; later status checks succeed (a supplier that recovers)
 *   mock-flaky          first call times out without booking, the second succeeds
 *   mock-down           every call, including the status check, fails: the outcome stays unknown, never Failed
 *   mock-cancel-fail    cancel is refused (the booking stays Cancel requested)
 *
 * State is in memory and per instance. It records whatever it "books" under our reference, which is what makes the status check meaningful.
 */
interface Held { state: 'CONFIRMED' | 'ON_REQUEST' | 'CANCELLED' | 'REJECTED'; supplierRef: string | null; hotelConfirmationNo: string | null; supplierCancellationRef?: string | null }

export class MockBookingSupplier implements BookingSupplierPort {
  readonly key: string
  private readonly held = new Map<string, Held>()
  private readonly calls = new Map<string, number>()
  constructor(key = 'mock') { this.key = key }

  private count(kind: string, reference: string): number { const k = `${kind}:${reference}`; const n = (this.calls.get(k) ?? 0) + 1; this.calls.set(k, n); return n }
  private scenario(supplierKey: string): string { return supplierKey.toLowerCase() }
  /** Test hook: what the mock currently holds under a reference. */
  peek(reference: string): Held | undefined { return this.held.get(reference) }

  /** Test hook: change what the mock holds, as if the supplier acted on its own (for example confirming an on-request booking). */
  set(reference: string, held: Held): void { this.held.set(reference, held) }

  async book(_context: BookingSupplierContext, request: BookingSupplierBookRequest): Promise<BookingSupplierBookResult> {
    const s = this.scenario(request.supplierKey); const n = this.count('book', request.reference)
    const confirm = (): BookingSupplierBookResult => { const h: Held = { state: 'CONFIRMED', supplierRef: `MOCK-${request.reference.slice(3, 11)}`, hotelConfirmationNo: `HC-${request.reference.slice(3, 9)}` }; this.held.set(request.reference, h); return { outcome: 'CONFIRMED', supplierRef: h.supplierRef, hotelConfirmationNo: h.hotelConfirmationNo } }
    switch (s) {
      case 'mock-confirm': return confirm()
      case 'mock-confirm-noref': this.held.set(request.reference, { state: 'CONFIRMED', supplierRef: null, hotelConfirmationNo: null }); return { outcome: 'CONFIRMED', supplierRef: null, hotelConfirmationNo: null }
      case 'mock-on-request': this.held.set(request.reference, { state: 'ON_REQUEST', supplierRef: `MOCK-${request.reference.slice(3, 11)}`, hotelConfirmationNo: null }); return { outcome: 'ON_REQUEST', supplierRef: `MOCK-${request.reference.slice(3, 11)}`, hotelConfirmationNo: null }
      case 'mock-reject': return { outcome: 'REJECTED', code: 'NO_AVAILABILITY' }
      case 'mock-timeout': throw new BookingSupplierCallError('timeout', 'SUPPLIER_TIMEOUT')
      case 'mock-ghost-late': if (n === 1) { confirm(); throw new BookingSupplierCallError('timeout', 'SUPPLIER_TIMEOUT') } return confirm()
      case 'mock-ghost': if (n === 1) { confirm(); throw new BookingSupplierCallError('timeout', 'SUPPLIER_TIMEOUT') } return confirm()
      case 'mock-flaky': if (n === 1) throw new BookingSupplierCallError('timeout', 'SUPPLIER_TIMEOUT'); return confirm()
      case 'mock-down': throw new BookingSupplierCallError('transport', 'SUPPLIER_UNREACHABLE')
      default: return confirm()
    }
  }

  async cancel(_context: BookingSupplierContext, request: { reference: string; supplierKey: string; supplierRef: string | null }): Promise<BookingSupplierCancelResult> {
    const s = this.scenario(request.supplierKey)
    if (s === 'mock-cancel-fail') return { outcome: 'REJECTED', code: 'CANCEL_NOT_ALLOWED' }
    const held = this.held.get(request.reference); const ref = `CXL-${request.reference.slice(3, 11)}`
    this.held.set(request.reference, { state: 'CANCELLED', supplierRef: held?.supplierRef ?? request.supplierRef, hotelConfirmationNo: held?.hotelConfirmationNo ?? null, supplierCancellationRef: ref })
    return { outcome: 'CANCELLED', supplierCancellationRef: ref }
  }

  async statusByReference(_context: BookingSupplierContext, request: { reference: string; supplierKey: string }): Promise<BookingSupplierStatus> {
    const s = this.scenario(request.supplierKey)
    if (s === 'mock-down') throw new BookingSupplierCallError('transport', 'SUPPLIER_UNREACHABLE')
    if (s === 'mock-ghost-late' && this.count('status', request.reference) === 1) throw new BookingSupplierCallError('transport', 'SUPPLIER_UNREACHABLE')
    const h = this.held.get(request.reference)
    return h ? { found: true, ...h } : { found: false }
  }
}
