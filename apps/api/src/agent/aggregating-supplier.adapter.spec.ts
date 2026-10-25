import type { FanoutLegEvent } from '@bedbanks/connectors-core'
import { InProcessGate } from '@bedbanks/connectors-core'
import type { SearchCriteria, SearchHotelOffer } from '@bedbanks/domain'
import { AggregatingSupplierAdapter, isAuthoritative, type AggregateMember } from './aggregating-supplier.adapter'
import { ContractedInventoryAdapter } from './contracted-inventory.adapter'
import { supplierAdapterFromEnvironment } from './supplier-adapter.factory'
import { SupplierProviderError, type SupplierAdapter, type SupplierSearchResult } from './supplier.port'

const criteria = { destination: 'Dubai', checkIn: '2027-03-10', checkOut: '2027-03-12', rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'GB', currency: 'AED' } as SearchCriteria
const searchContext = { tenantId: 'tenant-a', requestId: 'partner-req.2027:0001', userId: 'user-a' }
const requestContext = { tenantId: 'tenant-a', requestId: 'req-00000001', userId: 'user-a' }
const hotel = (id: string) => ({ hotelId: id }) as unknown as SearchHotelOffer
const ok = (ids: string[]): SupplierSearchResult => ({ offers: ids.map(hotel), providerSummary: { queried: 1, succeeded: 1, failed: 0 } })
const never = () => new Promise<never>(() => undefined)

function adapter(name: string, search: SupplierAdapter['search'], extra: Partial<SupplierAdapter> = {}): SupplierAdapter {
  return {
    name,
    search,
    recheck: jest.fn().mockResolvedValue({ status: 'unavailable' }),
    prebook: jest.fn().mockResolvedValue({ supplierReference: `${name}:ref-1` }),
    cancel: jest.fn().mockResolvedValue({ refundMinor: 0 }),
    ...extra,
  }
}
const member = (a: SupplierAdapter, prefix: string, extra: Partial<AggregateMember> = {}): AggregateMember =>
  ({ adapter: a, offerPrefix: `${prefix}_`, referencePrefix: `${a.name}:`, searchTimeoutMs: 1_000, ...extra })
const silent = { searchDeadlineMs: 2_000, event: () => undefined }

describe('AggregatingSupplierAdapter', () => {
  it('is transparent with one member: same name, authority, offers and summary', async () => {
    const contracted = adapter('contracted-inventory', async () => ok(['h1', 'h2']))
    const aggregate = new AggregatingSupplierAdapter([member(contracted, 'ci')], silent)
    expect(aggregate.name).toBe('contracted-inventory')
    expect(aggregate.authoritative).toBe(true)
    await expect(aggregate.search(criteria, searchContext)).resolves.toEqual(ok(['h1', 'h2']))
  })

  it('merges offers from every member and adds up their summaries', async () => {
    const aggregate = new AggregatingSupplierAdapter([
      member(adapter('contracted-inventory', async () => ok(['h1'])), 'ci'),
      member(adapter('bedbank-a', async () => ({ offers: [hotel('h2'), hotel('h3')], providerSummary: { queried: 2, succeeded: 1, failed: 1 } })), 'ba'),
    ], silent)
    expect(aggregate.name).toBe('aggregate')
    const result = await aggregate.search(criteria, searchContext)
    expect(result.offers.map(o => o.hotelId)).toEqual(['h1', 'h2', 'h3'])
    expect(result.providerSummary).toEqual({ queried: 3, succeeded: 2, failed: 1 })
  })

  it('a slow member is cut at its own timeout and counted as failed; the others still answer', async () => {
    const started = Date.now()
    const aggregate = new AggregatingSupplierAdapter([
      member(adapter('contracted-inventory', async () => ok(['h1'])), 'ci'),
      member(adapter('bedbank-slow', never), 'bs', { searchTimeoutMs: 50 }),
    ], silent)
    const result = await aggregate.search(criteria, searchContext)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.offers.map(o => o.hotelId)).toEqual(['h1'])
    expect(result.providerSummary).toEqual({ queried: 2, succeeded: 1, failed: 1 })
  })

  it('a member returning an impossible summary is treated as failed, and its offers are dropped', async () => {
    const aggregate = new AggregatingSupplierAdapter([
      member(adapter('contracted-inventory', async () => ok(['h1'])), 'ci'),
      member(adapter('bedbank-a', async () => ({ offers: [hotel('bad')], providerSummary: { queried: 1, succeeded: 2, failed: 0 } })), 'ba'),
    ], silent)
    const result = await aggregate.search(criteria, searchContext)
    expect(result.offers.map(o => o.hotelId)).toEqual(['h1'])
    expect(result.providerSummary).toEqual({ queried: 2, succeeded: 1, failed: 1 })
  })

  it('throws like a single failing adapter when every member fails', async () => {
    const aggregate = new AggregatingSupplierAdapter([
      member(adapter('contracted-inventory', async () => { throw new SupplierProviderError('unconfigured') }), 'ci'),
      member(adapter('bedbank-slow', never), 'bs', { searchTimeoutMs: 30 }),
    ], silent)
    await expect(aggregate.search(criteria, searchContext)).rejects.toBeInstanceOf(SupplierProviderError)
  })

  it('an open circuit skips the member without calling it', async () => {
    const search = jest.fn().mockRejectedValue(new SupplierProviderError('transport'))
    const gate = new InProcessGate({ failureThreshold: 1, openMs: 60_000 })
    const aggregate = new AggregatingSupplierAdapter([
      member(adapter('contracted-inventory', async () => ok(['h1'])), 'ci'),
      member(adapter('bedbank-a', search), 'ba', { gate }),
    ], silent)
    await aggregate.search(criteria, searchContext)
    await aggregate.search(criteria, searchContext)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('logs one sanitized event per member, with the request id made safe for suppliers', async () => {
    const events: FanoutLegEvent[] = []
    const aggregate = new AggregatingSupplierAdapter([member(adapter('contracted-inventory', async () => ok(['h1'])), 'ci')], { searchDeadlineMs: 1_000, event: e => events.push(e) })
    await aggregate.search(criteria, searchContext)
    expect(events).toEqual([expect.objectContaining({ supplierId: 'contracted-inventory', outcome: 'success', correlationId: 'partner-req-2027-0001' })])
  })

  it('routes recheck, prebook, cancel and the supplier key to the owning member only', async () => {
    const a = adapter('contracted-inventory', async () => ok([]), { recheck: jest.fn().mockResolvedValue({ status: 'offer_expired' }) })
    const b = adapter('bedbank-a', async () => ok([]))
    const aggregate = new AggregatingSupplierAdapter([member(a, 'ci'), member(b, 'ba')], silent)

    await expect(aggregate.recheck({ offerId: 'ci_1', searchId: 's' }, requestContext)).resolves.toEqual({ status: 'offer_expired' })
    await aggregate.prebook({ offerId: 'ba_9', searchId: 's', idempotencyKey: 'k' }, requestContext)
    await aggregate.cancel('bedbank-a:ref-1')
    expect(b.prebook).toHaveBeenCalledWith({ offerId: 'ba_9', searchId: 's', idempotencyKey: 'k' }, requestContext)
    expect(a.prebook).not.toHaveBeenCalled()
    expect(b.cancel).toHaveBeenCalledWith('bedbank-a:ref-1')
    expect(aggregate.supplierKeyFor('ci_1')).toBe('contracted-inventory')
    expect(aggregate.supplierKeyFor('ba_9')).toBe('bedbank-a')
  })

  it('never guesses an owner for an unknown offer or reference', async () => {
    const a = adapter('contracted-inventory', async () => ok([]))
    const aggregate = new AggregatingSupplierAdapter([member(a, 'ci')], silent)
    await expect(aggregate.recheck({ offerId: 'zz_1', searchId: 's' }, requestContext)).resolves.toEqual({ status: 'unavailable' })
    await expect(aggregate.prebook({ offerId: 'zz_1', searchId: 's', idempotencyKey: 'k' }, requestContext)).rejects.toBeInstanceOf(SupplierProviderError)
    await expect(aggregate.cancel('other:ref')).rejects.toBeInstanceOf(SupplierProviderError)
    expect(() => aggregate.supplierKeyFor('zz_1')).toThrow(SupplierProviderError)
    expect(a.recheck).not.toHaveBeenCalled()
  })

  it('refuses an ambiguous configuration', () => {
    const a = adapter('contracted-inventory', async () => ok([]))
    const b = adapter('bedbank-a', async () => ok([]))
    expect(() => new AggregatingSupplierAdapter([], silent)).toThrow('at least one supplier')
    expect(() => new AggregatingSupplierAdapter([member(a, 'ci'), member(b, 'ci')], silent)).toThrow('overlapping prefixes')
    expect(() => new AggregatingSupplierAdapter([member(a, 'ci'), member(b, 'ci_x')], silent)).toThrow('overlapping prefixes')
    expect(() => new AggregatingSupplierAdapter([member(a, 'ci'), member(a, 'zz', { referencePrefix: 'zz:' })], silent)).toThrow('listed twice')
    expect(() => new AggregatingSupplierAdapter([member(adapter('unconfigured', async () => ok([])), 'ci')], silent)).toThrow('invalid name')
    expect(() => new AggregatingSupplierAdapter([member({ ...a, name: undefined as unknown as string }, 'ci')], silent)).toThrow('invalid name')
    expect(() => new AggregatingSupplierAdapter([member(a, 'ci', { searchTimeoutMs: 0 })], silent)).toThrow('searchTimeoutMs')
    expect(() => new AggregatingSupplierAdapter([member(a, 'ci')], { searchDeadlineMs: 0 })).toThrow('searchDeadlineMs')
  })

  it('is authoritative when any member is, so a merged answer containing contracted inventory is never cached', () => {
    const external = adapter('bedbank-a', async () => ok([]))
    expect(new AggregatingSupplierAdapter([member(external, 'ba')], silent).authoritative).toBe(false)
    expect(new AggregatingSupplierAdapter([member(external, 'ba'), member(adapter('contracted-inventory', async () => ok([])), 'ci')], silent).authoritative).toBe(true)
    expect(isAuthoritative(adapter('x', async () => ok([]), { authoritative: true }))).toBe(true)
  })
})

describe('supplierAdapterFromEnvironment', () => {
  const contracted = new ContractedInventoryAdapter({} as never)

  it('uses contracted inventory directly unless aggregation is enabled', () => {
    expect(supplierAdapterFromEnvironment(contracted, {})).toBe(contracted)
    expect(supplierAdapterFromEnvironment(contracted, { AGENT_SUPPLIER_AGGREGATION: 'disabled' })).toBe(contracted)
  })

  it('wraps contracted inventory transparently when enabled', () => {
    const aggregate = supplierAdapterFromEnvironment(contracted, { AGENT_SUPPLIER_AGGREGATION: 'enabled' })
    expect(aggregate).toBeInstanceOf(AggregatingSupplierAdapter)
    expect(aggregate.name).toBe('contracted-inventory')
    expect(isAuthoritative(aggregate)).toBe(true)
  })

  it('refuses a typo or an out-of-range deadline instead of silently choosing', () => {
    expect(() => supplierAdapterFromEnvironment(contracted, { AGENT_SUPPLIER_AGGREGATION: 'on' })).toThrow('AGENT_SUPPLIER_AGGREGATION')
    for (const value of ['500', '12000', 'ten', '2500.5']) {
      expect(() => supplierAdapterFromEnvironment(contracted, { AGENT_SUPPLIER_AGGREGATION: 'enabled', AGENT_SEARCH_DEADLINE_MS: value })).toThrow('AGENT_SEARCH_DEADLINE_MS')
    }
  })
})

describe('AggregatingSupplierAdapter tracing', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  beforeAll(() => provider.register())
  afterAll(() => provider.shutdown())
  beforeEach(() => exporter.reset())

  it('records one fan-out span with a child per supplier, the failure as an error code, and no payload', async () => {
    const aggregate = new AggregatingSupplierAdapter([
      member(adapter('contracted-inventory', async () => ok(['h1'])), 'ci'),
      member(adapter('bedbank-a', async () => { throw new SupplierProviderError('transport') }), 'ba'),
    ], silent)
    await aggregate.search(criteria, searchContext)

    const spans = exporter.getFinishedSpans()
    const root = spans.find((s: { name: string }) => s.name === 'supplier.fanout.search')
    const legs = spans.filter((s: { name: string }) => s.name === 'supplier.search')
    expect(root.attributes).toMatchObject({ 'supplier.count': 2, 'supplier.queried': 2, 'supplier.succeeded': 1, 'supplier.failed': 1, 'supplier.offers': 1 })
    expect(root.events.map((e: { name: string }) => e.name)).toEqual(['supplier_leg', 'supplier_leg'])
    expect(legs).toHaveLength(2)
    for (const leg of legs) expect(leg.parentSpanContext?.spanId ?? leg.parentSpanId).toBe(root.spanContext().spanId)
    const failed = legs.find((s: { attributes: Record<string, unknown> }) => s.attributes['supplier.id'] === 'bedbank-a')
    expect(failed.attributes['error.code']).toBe('transport')
    expect(JSON.stringify(spans.map((s: { attributes: unknown; events: unknown }) => [s.attributes, s.events]))).not.toContain('Dubai')
  })

  it('marks the fan-out span as failed when every supplier fails', async () => {
    const aggregate = new AggregatingSupplierAdapter([member(adapter('bedbank-a', async () => { throw new SupplierProviderError('transport') }), 'ba')], silent)
    await expect(aggregate.search(criteria, searchContext)).rejects.toBeInstanceOf(SupplierProviderError)
    const root = exporter.getFinishedSpans().find((s: { name: string }) => s.name === 'supplier.fanout.search')
    expect(root.attributes['error.code']).toBe('transport')
  })
})
