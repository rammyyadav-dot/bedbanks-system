import { Logger } from '@nestjs/common'
import { fanOutRead, type ConnectorGate, type FanoutLegEvent } from '@bedbanks/connectors-core'
import type { SearchCriteria } from '@bedbanks/domain'
import { currentTraceId, withSpan } from '../observability/tracing'
import {
  SupplierProviderError,
  type PrebookRequest,
  type SupplierAdapter,
  type SupplierRecheckRequest,
  type SupplierRecheckResult,
  type SupplierRequestContext,
  type SupplierSearchContext,
  type SupplierSearchResult,
} from './supplier.port'

/**
 * One `SupplierAdapter` in front of several (ADR 0075). Search fans out to every member through `fanOutRead`, each member
 * bounded by its own deadline and gate, so one slow supplier cannot hold the answer. Nothing else fans out: recheck and
 * prebook go to the member that minted the offer (by `offerPrefix`), cancel to the member that issued the reference
 * (by `referencePrefix`). An offer or reference no member owns is never guessed at.
 *
 * Failure policy (invariant 5): a failed member contributes no offers and is counted in `providerSummary.failed`, so the
 * search answer is `partial`, not a quiet "no availability". When every member fails, search throws, exactly as a
 * single failing adapter does today.
 */
export interface AggregateMember {
  adapter: SupplierAdapter
  /** Every offerId this member mints starts with this prefix, and no other member's prefix overlaps it. */
  offerPrefix: string
  /** Every supplierReference this member's prebook returns starts with this prefix. */
  referencePrefix: string
  /** Search budget for this member. Capped by the overall deadline. */
  searchTimeoutMs: number
  /** Circuit breaker for external suppliers (`SharedConnectorGate`). Omitted for in-house inventory: no circuit, no limit. */
  gate?: ConnectorGate
}

export interface AggregateOptions {
  /** Hard budget for one search across all members. */
  searchDeadlineMs: number
  /** Receives the sanitized per-member event. Defaults to one structured log line. */
  event?: (event: FanoutLegEvent) => void
}

const NO_GATE: ConnectorGate = { acquire: async () => () => undefined }
const SEARCH = { name: 'search', kind: 'read' as const }
const MEMBER_ID = /^[a-zA-Z0-9_-]{1,100}$/

export class AggregatingSupplierAdapter implements SupplierAdapter {
  readonly name: string
  readonly authoritative: boolean
  private readonly logger = new Logger(AggregatingSupplierAdapter.name)

  constructor(private readonly members: readonly AggregateMember[], private readonly options: AggregateOptions) {
    if (members.length === 0) throw new Error('An aggregate needs at least one supplier; use UnconfiguredSupplierAdapter instead')
    if (!Number.isSafeInteger(options.searchDeadlineMs) || options.searchDeadlineMs <= 0) throw new Error('searchDeadlineMs must be a positive integer')
    for (const [i, member] of members.entries()) {
      if (typeof member.adapter.name !== 'string' || !MEMBER_ID.test(member.adapter.name) || member.adapter.name === 'unconfigured') throw new Error(`Supplier ${i} has an invalid name`)
      if (!member.offerPrefix || !member.referencePrefix) throw new Error(`Supplier ${member.adapter.name} must declare offer and reference prefixes`)
      if (!Number.isSafeInteger(member.searchTimeoutMs) || member.searchTimeoutMs <= 0) throw new Error(`Supplier ${member.adapter.name} needs a positive searchTimeoutMs`)
      for (const other of members.slice(i + 1)) {
        if (other.adapter.name === member.adapter.name) throw new Error(`Supplier ${member.adapter.name} is listed twice`)
        if (overlaps(other.offerPrefix, member.offerPrefix) || overlaps(other.referencePrefix, member.referencePrefix)) {
          throw new Error(`Suppliers ${member.adapter.name} and ${other.adapter.name} have overlapping prefixes`)
        }
      }
    }
    // With one member the aggregate is transparent: the same name, so caching, audit and the mutation journal see no change.
    this.name = members.length === 1 ? members[0].adapter.name : 'aggregate'
    this.authoritative = members.some(m => isAuthoritative(m.adapter))
  }

  async search(criteria: SearchCriteria, context: SupplierSearchContext): Promise<SupplierSearchResult> {
    // One span for the whole fan-out and one child per supplier leg (ADR 0093): the slowest child is the bottleneck, and a leg that
    // outlives the deadline shows up as a child that ends after its parent. No criteria, offers or payloads are attached.
    return withSpan('supplier.fanout.search', { 'supplier.count': this.members.length, 'supplier.deadline_ms': this.options.searchDeadlineMs }, async span => {
      const result = await this.fanOut(criteria, context, (event) => span.addEvent('supplier_leg', {
        'supplier.id': event.supplierId,
        'supplier.outcome': event.outcome,
        'supplier.duration_ms': event.durationMs,
        'supplier.fallback_used': event.fallbackUsed,
      }))
      const aggregated = this.aggregate(result)
      span.setAttributes({ 'supplier.queried': aggregated.providerSummary.queried, 'supplier.succeeded': aggregated.providerSummary.succeeded, 'supplier.failed': aggregated.providerSummary.failed, 'supplier.offers': aggregated.offers.length })
      return aggregated
    })
  }

  private fanOut(criteria: SearchCriteria, context: SupplierSearchContext, onEvent: (event: FanoutLegEvent) => void) {
    const log = this.options.event ?? (event => this.logger.log(JSON.stringify({ event: 'supplier_leg', traceId: currentTraceId(), ...event })))
    return fanOutRead(this.members.map(member => ({
      supplierId: member.adapter.name,
      connectorId: member.adapter.name,
      gate: member.gate ?? NO_GATE,
      timeoutMs: member.searchTimeoutMs,
      // Member adapters do not take a signal yet: an abandoned search finishes in the background and its answer is discarded.
      call: () => withSpan('supplier.search', { 'supplier.id': member.adapter.name, 'supplier.timeout_ms': member.searchTimeoutMs }, () => member.adapter.search(criteria, context)),
    })), {
      operation: SEARCH,
      correlationId: correlationId(context.requestId),
      deadlineMs: this.options.searchDeadlineMs,
      event: event => { onEvent(event); log(event) },
    })
  }

  private aggregate(result: Awaited<ReturnType<AggregatingSupplierAdapter['fanOut']>>): SupplierSearchResult {
    const offers: SupplierSearchResult['offers'] = []
    const summary = { queried: 0, succeeded: 0, failed: 0 }
    for (const leg of result.legs) {
      if (leg.status === 'ok' && validSummary(leg.value.providerSummary)) {
        offers.push(...leg.value.offers)
        summary.queried += leg.value.providerSummary.queried
        summary.succeeded += leg.value.providerSummary.succeeded
        summary.failed += leg.value.providerSummary.failed
      } else {
        summary.queried += 1
        summary.failed += 1
      }
    }
    if (summary.succeeded === 0 && summary.failed > 0) throw new SupplierProviderError(result.legs.some(l => l.status === 'failed' && l.failure === 'timeout') ? 'timeout' : 'transport')
    return { offers, providerSummary: summary }
  }

  async recheck(request: SupplierRecheckRequest, context: SupplierRequestContext): Promise<SupplierRecheckResult> {
    const owner = this.ownerOfOffer(request.offerId)
    return owner ? owner.adapter.recheck(request, context) : { status: 'unavailable' }
  }

  async prebook(request: PrebookRequest, context: SupplierRequestContext): ReturnType<SupplierAdapter['prebook']> {
    const owner = this.ownerOfOffer(request.offerId)
    if (!owner) throw new SupplierProviderError('malformed_response')
    return owner.adapter.prebook(request, context)
  }

  async cancel(supplierReference: string): Promise<{ refundMinor: number }> {
    const owner = this.members.find(m => supplierReference.startsWith(m.referencePrefix))
    if (!owner) throw new SupplierProviderError('unconfigured')
    return owner.adapter.cancel(supplierReference)
  }

  supplierKeyFor(offerId: string): string {
    const owner = this.ownerOfOffer(offerId)
    if (!owner) throw new SupplierProviderError('malformed_response')
    return owner.adapter.supplierKeyFor?.(offerId) ?? owner.adapter.name
  }

  private ownerOfOffer(offerId: string): AggregateMember | undefined {
    return this.members.find(m => offerId.startsWith(m.offerPrefix))
  }
}

function overlaps(a: string, b: string): boolean { return a.startsWith(b) || b.startsWith(a) }

export function isAuthoritative(adapter: SupplierAdapter): boolean {
  return adapter.authoritative === true || adapter.name === 'contracted-inventory'
}

/** Request ids may carry `.` and `:` (RequestIdMiddleware); supplier correlation ids may not. */
function correlationId(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100) || 'none'
}

function validSummary(s: SupplierSearchResult['providerSummary'] | undefined): boolean {
  return !!s && [s.queried, s.succeeded, s.failed].every(n => Number.isSafeInteger(n) && n >= 0) && s.succeeded + s.failed <= s.queried
}
