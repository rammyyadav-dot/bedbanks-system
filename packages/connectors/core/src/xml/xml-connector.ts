import type { ConnectorCapability } from '../index'
import type { XmlNode } from './xml-parser'
import type { XmlRequest, XmlSupplierTransport } from './xml-transport'
import {
  SupplierCallError, isIsoDate, isOffsetTimestamp, validateSearchQuery,
  type SupplierBookRequest, type SupplierBookResult, type SupplierCallContext, type SupplierCancelResult, type SupplierErrorCode, type SupplierOfferObservation,
  type SupplierRecheckResult, type SupplierSearchQuery, type SupplierSearchResult, type SupplierStatusResult,
} from './supplier-types'

/**
 * A provider profile is the ONLY place supplier-specific XML lives: request builders, response mappers and the
 * supplier's fault vocabulary. The shared `XmlSupplierConnector` owns validation, error classification and the
 * mutation rules, so a new supplier cannot weaken them.
 *
 * Provider XML types never leave the profile. Everything returned is a canonical type from ./supplier-types.
 */
export type CertificationLevel = 'NOT_IMPLEMENTED' | 'FIXTURE_ONLY' | 'SANDBOX_CERTIFIED' | 'PRODUCTION_CERTIFIED'

export interface SupplierFault {
  /** Supplier machine code only, for support correlation. Never free text. */
  code: string | null
  kind: 'authentication' | 'quota' | 'unavailable' | 'rejected' | 'not_found' | 'other'
}
export interface OperationSpec<I, O, S> {
  build(input: I, secrets: S, context: SupplierCallContext): XmlRequest
  parse(root: XmlNode, input: I, receivedAt: Date): O
}
export interface XmlProviderProfile<S> {
  readonly provider: string
  readonly profileVersion: string
  readonly certification: CertificationLevel
  readonly capabilities: readonly ConnectorCapability[]
  /** Recognise the supplier's error/fault envelope, or return null for a normal document. */
  faultOf(root: XmlNode): SupplierFault | null
  readonly search?: OperationSpec<SupplierSearchQuery, SupplierOfferObservation[], S>
  readonly recheck?: OperationSpec<{ rateToken: string; query: SupplierSearchQuery }, SupplierRecheckResult, S>
  readonly book?: OperationSpec<SupplierBookRequest, SupplierBookResult, S>
  readonly cancel?: OperationSpec<{ reference: string; supplierRef: string | null; idempotencyKey: string }, SupplierCancelResult, S>
  readonly status?: OperationSpec<{ reference: string }, SupplierStatusResult, S>
}

const FAULT_CODE: Record<SupplierFault['kind'], SupplierErrorCode> = {
  authentication: 'authentication', quota: 'quota_exhausted', unavailable: 'provider_unavailable', rejected: 'supplier_fault', not_found: 'supplier_fault', other: 'supplier_fault',
}
const MAX_OFFERS = 5_000

export class XmlSupplierConnector<S> {
  constructor(readonly profile: XmlProviderProfile<S>, private readonly transport: XmlSupplierTransport<S>, private readonly now: () => Date = () => new Date()) {}

  private require<I, O>(capability: ConnectorCapability, spec: OperationSpec<I, O, S> | undefined): OperationSpec<I, O, S> {
    if (!spec || !this.profile.capabilities.includes(capability)) throw new SupplierCallError('unsupported', 'not_sent')
    return spec
  }

  /** Runs one operation: transport, fault detection, mapping. Mutations never leave the `maybe_sent` state unresolved. */
  private async run<I, O>(name: string, kind: 'read' | 'mutation', spec: OperationSpec<I, O, S>, input: I, context: SupplierCallContext, validate: (output: O) => void): Promise<O> {
    const response = await this.transport.send({ name, kind }, (secrets) => spec.build(input, secrets, context), context)
    const afterSend = kind === 'mutation' ? 'maybe_sent' : 'answered'
    try {
      const fault = this.profile.faultOf(response.root)
      if (fault) {
        // A definite rejection before processing is "answered"; an unavailable fault on a mutation may have acted.
        const code = FAULT_CODE[fault.kind]
        throw new SupplierCallError(code, fault.kind === 'unavailable' ? afterSend : 'answered', null, fault.code)
      }
      const output = spec.parse(response.root, input, this.now())
      validate(output)
      return output
    } catch (error) {
      if (error instanceof SupplierCallError) throw error
      // A parser that throws on an unexpected shape is a malformed response, never a partial result.
      throw new SupplierCallError('malformed_response', afterSend)
    }
  }

  async search(query: SupplierSearchQuery, context: SupplierCallContext): Promise<SupplierSearchResult> {
    const spec = this.require('search', this.profile.search)
    validateSearchQuery(query)
    const offers = await this.run('search', 'read', spec, query, context, (o) => assertOffers(o, query))
    return { offers }
  }

  async recheck(input: { rateToken: string; query: SupplierSearchQuery }, context: SupplierCallContext): Promise<SupplierRecheckResult> {
    const spec = this.require('recheck', this.profile.recheck)
    validateSearchQuery(input.query)
    if (!input.rateToken || input.rateToken.length > 4096 || /[\r\n]/.test(input.rateToken)) throw new SupplierCallError('unsupported', 'not_sent')
    return this.run('recheck', 'read', spec, input, context, (r) => {
      if ((r.status === 'unavailable') !== (r.offer === null)) throw new SupplierCallError('malformed_response', 'answered')
      if (r.offer) assertOffers([r.offer], input.query)
    })
  }

  async book(request: SupplierBookRequest, context: SupplierCallContext): Promise<SupplierBookResult> {
    const spec = this.require('book', this.profile.book)
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(request.idempotencyKey) || !/^[A-Za-z0-9_-]{3,64}$/.test(request.reference) || !Number.isSafeInteger(request.expectedNetMinor) || request.expectedNetMinor <= 0 || !/^[A-Z]{3}$/.test(request.currency) || request.rooms.length === 0 || request.rooms.some((r) => r.guests.length === 0)) {
      throw new SupplierCallError('unsupported', 'not_sent')
    }
    return this.run('book', 'mutation', spec, request, context, (r) => {
      if (r.outcome === 'CONFIRMED' && !r.supplierRef && !r.hotelConfirmationNo) throw new SupplierCallError('malformed_response', 'maybe_sent')
    })
  }

  async cancel(input: { reference: string; supplierRef: string | null; idempotencyKey: string }, context: SupplierCallContext): Promise<SupplierCancelResult> {
    const spec = this.require('cancel', this.profile.cancel)
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(input.reference) || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new SupplierCallError('unsupported', 'not_sent')
    return this.run('cancel', 'mutation', spec, input, context, (r) => {
      if (r.outcome === 'CANCELLED' && r.penaltyMinor !== null && (!Number.isSafeInteger(r.penaltyMinor) || r.penaltyMinor < 0)) throw new SupplierCallError('malformed_response', 'maybe_sent')
    })
  }

  /** Ask what the supplier holds under our reference. A read, so it is safe to retry; it is how an unknown mutation is resolved. */
  async statusByReference(reference: string, context: SupplierCallContext): Promise<SupplierStatusResult> {
    const spec = this.require('status', this.profile.status)
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(reference)) throw new SupplierCallError('unsupported', 'not_sent')
    return this.run('status', 'read', spec, { reference }, context, () => undefined)
  }
}

/** Invariants every offer must satisfy regardless of provider. A violation rejects the whole response: no partial inventory. */
export function assertOffers(offers: SupplierOfferObservation[], query: SupplierSearchQuery): void {
  if (!Array.isArray(offers) || offers.length > MAX_OFFERS) throw new SupplierCallError('malformed_response', 'answered')
  const hotels = new Set(query.supplierHotelCodes)
  const seen = new Set<string>()
  for (const o of offers) {
    const ok = typeof o.supplierHotelCode === 'string' && hotels.has(o.supplierHotelCode) &&
      !!o.supplierRoomCode && !!o.rateToken && o.rateToken.length <= 4096 && !seen.has(o.rateToken) &&
      o.currency === query.currency && Number.isSafeInteger(o.netMinor) && o.netMinor > 0 &&
      isIsoDate(o.checkIn) && o.checkIn === query.checkIn && isIsoDate(o.checkOut) && o.checkOut === query.checkOut &&
      Number.isInteger(o.roomIndex) && o.roomIndex >= 0 && o.roomIndex < query.rooms.length &&
      o.cancellationPolicies.every((p) => isOffsetTimestamp(p.from) && Number.isSafeInteger(p.penaltyMinor) && p.penaltyMinor >= 0) &&
      (o.supplierExpiresAt === null || isOffsetTimestamp(o.supplierExpiresAt)) && Number.isFinite(Date.parse(o.receivedAt))
    if (!ok) throw new SupplierCallError('malformed_response', 'answered')
    seen.add(o.rateToken)
  }
}
