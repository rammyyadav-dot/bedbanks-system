import type { SupplierBookResult, SupplierCallContext, SupplierCancelResult, SupplierStatusResult, SupplierBookRequest } from '@bedbanks/connectors-core'
import {
  BookingSupplierCallError, type BookingSupplierBookRequest, type BookingSupplierBookResult, type BookingSupplierCancelResult, type BookingSupplierContext, type BookingSupplierPort, type BookingSupplierStatus,
} from './booking-supplier.port'

/**
 * Adapts one configured XML supplier connector (WebBeds, TBO, Darina... through @bedbanks/connectors-core) to the Admin booking queue port.
 *
 * Not wired into `BookingSupplierRegistry` yet: that happens per supplier, only after a provider profile reaches PRODUCTION_CERTIFIED and the
 * readiness gates pass (docs/connectors/xml-supplier-onboarding.md). This file only fixes the rules of the translation:
 *  - a definite supplier refusal becomes REJECTED; everything else THROWS, because the runner treats a throw as "we do not know" and then asks
 *    `statusByReference` before it may call a booking failed (no ghost bookings, no duplicates);
 *  - authentication, quota and availability faults are operational, so they throw and the runner retries; they never become REJECTED;
 *  - the supplier idempotency key is derived from our booking reference, so a retry of the same logical booking reuses it;
 *  - the port deliberately carries no guest data and no rate token, so a `BookInputs` resolver supplies them from the audited booking store.
 */
export interface BookInputs { rateToken: string; expectedNetMinor: number; rooms: SupplierBookRequest['rooms'] }
export interface BookInputResolver { resolve(context: BookingSupplierContext, request: BookingSupplierBookRequest): Promise<BookInputs> }
/** The slice of XmlSupplierConnector this adapter uses, so tests and wiring do not depend on transport details. */
export interface XmlConnectorPort {
  book(request: SupplierBookRequest, context: SupplierCallContext): Promise<SupplierBookResult>
  cancel(input: { reference: string; supplierRef: string | null; idempotencyKey: string }, context: SupplierCallContext): Promise<SupplierCancelResult>
  statusByReference(reference: string, context: SupplierCallContext): Promise<SupplierStatusResult>
}
export interface XmlBookingSupplierScope { supplierId: string; connectorId: string }

interface CallErrorLike { name: string; code: string; delivery: string; supplierCode?: string | null }
const isCallError = (error: unknown): error is CallErrorLike => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SupplierCallError'

export class XmlBookingSupplier implements BookingSupplierPort {
  constructor(readonly key: string, private readonly connector: XmlConnectorPort, private readonly scope: XmlBookingSupplierScope, private readonly inputs: BookInputResolver) {}

  private context(context: BookingSupplierContext): SupplierCallContext {
    return { tenantId: context.tenantId, supplierId: this.scope.supplierId, connectorId: this.scope.connectorId, correlationId: context.requestId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100) || 'none' }
  }
  private idempotencyKey(reference: string, action: 'book' | 'cancel'): string { return `${reference}-${action}`.replace(/[^A-Za-z0-9_-]/g, '-') }

  /** Returns the refusal code for a definite supplier refusal; throws BookingSupplierCallError for every other failure. */
  private refusal(error: unknown): string {
    if (!isCallError(error)) throw new BookingSupplierCallError('error', 'UNCLASSIFIED')
    if (error.code === 'supplier_fault' && error.delivery === 'answered') return `SUPPLIER_${(error.supplierCode ?? 'REFUSED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32) || 'REFUSED'}`
    const kind = error.code === 'timeout' ? 'timeout' : error.code === 'transport' || error.code === 'provider_unavailable' || error.code === 'circuit_open' ? 'transport' : 'error'
    throw new BookingSupplierCallError(kind, error.code.toUpperCase())
  }

  async book(context: BookingSupplierContext, request: BookingSupplierBookRequest): Promise<BookingSupplierBookResult> {
    let inputs: BookInputs
    try { inputs = await this.inputs.resolve(context, request) } catch { throw new BookingSupplierCallError('error', 'BOOK_INPUTS_UNAVAILABLE') }
    try {
      return await this.connector.book({ reference: request.reference, idempotencyKey: this.idempotencyKey(request.reference, 'book'), rateToken: inputs.rateToken, currency: request.currency, expectedNetMinor: inputs.expectedNetMinor, rooms: inputs.rooms }, this.context(context))
    } catch (error) { return { outcome: 'REJECTED', code: this.refusal(error) } }
  }

  async cancel(context: BookingSupplierContext, request: { reference: string; supplierKey: string; supplierRef: string | null }): Promise<BookingSupplierCancelResult> {
    try {
      const result = await this.connector.cancel({ reference: request.reference, supplierRef: request.supplierRef, idempotencyKey: this.idempotencyKey(request.reference, 'cancel') }, this.context(context))
      return result.outcome === 'CANCELLED' ? { outcome: 'CANCELLED', supplierCancellationRef: result.supplierCancellationRef } : result
    } catch (error) { return { outcome: 'REJECTED', code: this.refusal(error) } }
  }

  async statusByReference(context: BookingSupplierContext, request: { reference: string; supplierKey: string }): Promise<BookingSupplierStatus> {
    try { return await this.connector.statusByReference(request.reference, this.context(context)) } catch (error) { this.refusal(error); throw new BookingSupplierCallError('error', 'STATUS_REFUSED') }
  }
}
