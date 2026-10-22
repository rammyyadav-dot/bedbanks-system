import { randomBytes } from 'crypto'
import { PrismaClient, type Prisma } from '@prisma/client'
import type { IngestAllotment, IngestCancellationPolicy, IngestRate, IngestResult } from '@bedbanks/connectors-core'
import { IngestPersistenceError, persistAllotments, persistCancellationPolicies, persistRates, type PersistScope } from '../src/supplier-ingest/ingest-persistence'

jest.setTimeout(120_000)

/** Supplier ingestion persistence (ADR 0078): idempotency, newer-feed-wins, evidence-only partial runs, and the database guards. */
describe('supplier ingest persistence (PostgreSQL)', () => {
  const prisma = new PrismaClient()
  const suffix = `ing-${Date.now()}-${randomBytes(3).toString('hex')}`
  let userId = '', tenantA = '', tenantB = '', supplierA = '', supplierB = '', connA = '', connB = '', connDisabled = ''
  const t0 = new Date('2027-01-10T10:00:00.000Z')
  const scope = (key: string, patch: Partial<PersistScope> = {}): PersistScope => ({
    tenantId: tenantA, supplierId: supplierA, connectorId: connA, idempotencyKey: key, actorUserId: userId,
    receivedAt: t0, sourceUpdatedAt: null, freshUntil: new Date(t0.getTime() + 3_600_000), ...patch,
  })
  const inTenant = <T,>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`; return work(tx) })
  const rate = (date: string, net: number, extra: Partial<IngestRate> = {}): IngestRate => ({
    supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: 'BAR', boardCode: 'BB', stayDate: date, currency: 'AED', netMinor: net,
    taxesIncluded: null, minStay: null, maxStay: null, closedToArrival: false, closedToDeparture: false, ...extra,
  })
  const result = <T,>(accepted: T[], status: IngestResult<T>['status'] = 'COMPLETE', rejected: IngestResult<T>['rejected'] = []): IngestResult<T> => ({ accepted, rejected, extracted: accepted.length + rejected.length, status })
  const connector = (tenantId: string, supplierId: string, name: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') =>
    prisma.connectorDefinition.create({ data: { tenantId, supplierId, type: 'XML_IN', status, name, version: '0.0.1' } }).then((c) => c.id)
  const supplier = (tenantId: string, n: string) => prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${n}`, displayName: n, countryCode: 'AE', defaultCurrency: 'AED' } as never }).then((s) => s.id)

  beforeAll(async () => {
    await prisma.$connect()
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierA = await supplier(tenantA, 'SA'); supplierB = await supplier(tenantB, 'SB')
    connA = await connector(tenantA, supplierA, 'cm-a'); connDisabled = await connector(tenantA, supplierA, 'cm-off', 'DISABLED'); connB = await connector(tenantB, supplierB, 'cm-b')
  })

  afterAll(async () => {
    // Owner-governed erasure: the application never sets this flag.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('fbeds.ingest_erasure', 'on', true)`
      for (const tenantId of [tenantA, tenantB]) {
        await tx.supplierRateObservation.deleteMany({ where: { tenantId } }); await tx.supplierAllotmentObservation.deleteMany({ where: { tenantId } })
        await tx.supplierCancellationObservation.deleteMany({ where: { tenantId } }); await tx.supplierIngestRun.deleteMany({ where: { tenantId } })
      }
    })
    for (const tenantId of [tenantA, tenantB]) {
      await prisma.auditEvent.deleteMany({ where: { tenantId, entityType: 'supplier_ingest_run' } }).catch(() => undefined)
      await prisma.connectorDefinition.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } })
    }
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.auditEvent.deleteMany({ where: { userId } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  it('SI-01 a COMPLETE rates run writes observations and an audit event; a replay writes nothing; the same key with other content is refused', async () => {
    const r = result([rate('2027-03-05', 41250), rate('2027-03-06', 40000, { taxesIncluded: true })])
    const first = await inTenant(tenantA, (tx) => persistRates(tx, scope('key-rates-0001'), r))
    expect(first).toMatchObject({ status: 'COMPLETE', applied: true, replayed: false, written: 2, superseded: 0 })
    const rows = await prisma.supplierRateObservation.findMany({ where: { tenantId: tenantA }, orderBy: { stayDate: 'asc' } })
    expect(rows.map((x) => [x.netMinor, x.taxesIncluded, x.runId])).toEqual([[41250n, null, first.runId], [40000n, true, first.runId]])
    expect(await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: first.runId, action: 'supplier.ingest.complete' } })).toBe(1)

    const again = await inTenant(tenantA, (tx) => persistRates(tx, scope('key-rates-0001'), result([rate('2027-03-06', 40000, { taxesIncluded: true }), rate('2027-03-05', 41250)])))
    expect(again).toMatchObject({ runId: first.runId, replayed: true, written: 0 })
    expect(await prisma.supplierIngestRun.count({ where: { tenantId: tenantA, idempotencyKey: 'key-rates-0001' } })).toBe(1)
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('key-rates-0001'), result([rate('2027-03-05', 99999)])))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('SI-02 a PARTIAL run is recorded as evidence with reject counts only and applies nothing', async () => {
    const before = await prisma.supplierRateObservation.count({ where: { tenantId: tenantA } })
    const out = await inTenant(tenantA, (tx) => persistRates(tx, scope('key-partial-01'), result([rate('2027-04-01', 10000)], 'PARTIAL', [{ kind: 'rate', index: 1, code: 'invalid_amount', field: 'netAmount' }, { kind: 'rate', index: 2, code: 'invalid_amount', field: 'netAmount' }])))
    expect(out).toMatchObject({ status: 'PARTIAL', applied: false, written: 0 })
    expect(await prisma.supplierRateObservation.count({ where: { tenantId: tenantA } })).toBe(before)
    const run = await prisma.supplierIngestRun.findFirstOrThrow({ where: { tenantId: tenantA, idempotencyKey: 'key-partial-01' } })
    expect(run).toMatchObject({ applied: false, freshUntil: null, rejectedCount: 2, acceptedCount: 1 })
    expect(run.rejectSummary).toEqual({ 'invalid_amount:netAmount': 2 })
  })

  it('SI-03 a newer feed overwrites; a delayed older feed cannot', async () => {
    const newer = scope('key-newer-0001', { receivedAt: new Date(t0.getTime() + 60_000), freshUntil: new Date(t0.getTime() + 7_200_000) })
    const o1 = await inTenant(tenantA, (tx) => persistRates(tx, newer, result([rate('2027-03-05', 45000)])))
    expect(o1.written).toBe(1)
    const o2 = await inTenant(tenantA, (tx) => persistRates(tx, scope('key-older-0001', { receivedAt: new Date(t0.getTime() - 60_000) }), result([rate('2027-03-05', 1000)])))
    expect(o2).toMatchObject({ written: 0, superseded: 1 })
    const row = await prisma.supplierRateObservation.findFirstOrThrow({ where: { tenantId: tenantA, stayDate: new Date('2027-03-05') } })
    expect(row.netMinor).toBe(45000n)
    expect(row.runId).toBe(o1.runId)
  })

  it('SI-04 allotments and cancellation policies persist; a missing count cannot be stored as zero', async () => {
    const a: IngestAllotment[] = [
      { supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: null, stayDate: '2027-03-05', mode: 'ALLOTMENT', available: 4, stopSell: false, releaseDays: 3 },
      { supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: null, stayDate: '2027-03-06', mode: 'FREE_SALE', available: null, stopSell: false, releaseDays: null },
    ]
    expect((await inTenant(tenantA, (tx) => persistAllotments(tx, scope('key-allot-0001'), result(a)))).written).toBe(2)
    const stored = await prisma.supplierAllotmentObservation.findMany({ where: { tenantId: tenantA }, orderBy: { stayDate: 'asc' } })
    expect(stored.map((x) => [x.mode, x.available, x.supplierRatePlanCode])).toEqual([['ALLOTMENT', 4, ''], ['FREE_SALE', null, '']])
    await expect(inTenant(tenantA, (tx) => persistAllotments(tx, scope('key-allot-0002'), result([{ ...a[0], stayDate: '2027-03-07', available: null }])))).rejects.toThrow(/check constraint|violat/i)

    const p: IngestCancellationPolicy[] = [{ supplierHotelCode: 'H1', supplierRoomCode: null, supplierRatePlanCode: 'BAR', nonRefundable: false, windows: [{ from: '2027-04-09T20:00:00.000Z', penalty: { type: 'PERCENT', basisPoints: 5050 } }] }]
    expect((await inTenant(tenantA, (tx) => persistCancellationPolicies(tx, scope('key-canc-00001'), result(p)))).written).toBe(1)
    const pol = await prisma.supplierCancellationObservation.findFirstOrThrow({ where: { tenantId: tenantA } })
    expect(pol.windows).toEqual(p[0].windows)
  })

  it('SI-05 a disabled connector, another tenant\'s connector, and invalid input are refused before anything is written', async () => {
    const before = await prisma.supplierIngestRun.count({ where: { tenantId: tenantA } })
    const r = result([rate('2027-05-01', 100)])
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('key-disabled-01', { connectorId: connDisabled }), r))).rejects.toMatchObject({ code: 'CONNECTOR_NOT_ACTIVE' })
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('key-foreign-001', { connectorId: connB, supplierId: supplierB }), r))).rejects.toMatchObject({ code: 'CONNECTOR_NOT_ACTIVE' })
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('key-foreign-002', { connectorId: connB }), r))).rejects.toMatchObject({ code: 'CONNECTOR_NOT_ACTIVE' })
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('x'), r))).rejects.toBeInstanceOf(IngestPersistenceError)
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('key-stale-0001', { freshUntil: t0 }), r))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await prisma.supplierIngestRun.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('SI-06 database guards: a run cannot be applied unless COMPLETE, money must be positive, rows are append-only and tenant keys are composite', async () => {
    const run = (patch: object) => prisma.supplierIngestRun.create({ data: { tenantId: tenantA, supplierId: supplierA, connectorId: connA, kind: 'RATES', idempotencyKey: `raw-${randomBytes(6).toString('hex')}`, requestHash: 'a'.repeat(64), status: 'COMPLETE', extractedCount: 1, acceptedCount: 1, rejectedCount: 0, applied: true, receivedAt: t0, freshUntil: new Date(t0.getTime() + 1000), ...patch } })
    await expect(run({ status: 'PARTIAL' })).rejects.toThrow(/check constraint|violat/i)
    await expect(run({ freshUntil: null })).rejects.toThrow(/check constraint|violat/i)
    await expect(run({ requestHash: 'XYZ' })).rejects.toThrow(/check constraint|violat/i)
    await expect(run({ supplierId: supplierB })).rejects.toThrow(/Foreign key|violat/i)
    const ok = await run({})
    await expect(prisma.supplierIngestRun.update({ where: { id: ok.id }, data: { status: 'FAILED' } })).rejects.toThrow(/append-only/)
    await expect(prisma.supplierIngestRun.delete({ where: { id: ok.id } })).rejects.toThrow(/append-only/)
    await expect(inTenant(tenantA, (tx) => persistRates(tx, scope('key-zero-00001'), result([rate('2027-06-01', 0)])))).rejects.toThrow(/check constraint|violat/i)
    const obs = await prisma.supplierRateObservation.findFirstOrThrow({ where: { tenantId: tenantA } })
    await expect(prisma.supplierRateObservation.delete({ where: { id: obs.id } })).rejects.toThrow(/never deleted/)
    await expect(prisma.supplierRateObservation.update({ where: { id: obs.id }, data: { supplierHotelCode: 'OTHER' } })).rejects.toThrow(/identity is immutable/)
    await expect(prisma.supplierRateObservation.update({ where: { id: obs.id }, data: { receivedAt: new Date(0), freshUntil: new Date(1000) } })).rejects.toThrow(/older feed/)
    await expect(prisma.supplierRateObservation.create({ data: { tenantId: tenantB, supplierId: supplierA, runId: ok.id, supplierHotelCode: 'H', supplierRoomCode: 'R', supplierRatePlanCode: 'P', stayDate: new Date('2027-03-05'), currency: 'AED', netMinor: 1n, closedToArrival: false, closedToDeparture: false, receivedAt: t0, freshUntil: new Date(t0.getTime() + 1000) } })).rejects.toThrow(/Foreign key|violat/i)
  })

  it('SI-07 forced row-level security: a non-owner role sees only its tenant\'s ingestion rows, and none without tenant context', async () => {
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_ingest_rls_probe') THEN CREATE ROLE fbeds_ingest_rls_probe NOLOGIN; END IF; END $$`)
    await prisma.$executeRawUnsafe('GRANT SELECT ON "SupplierIngestRun", "SupplierRateObservation", "SupplierAllotmentObservation", "SupplierCancellationObservation" TO fbeds_ingest_rls_probe')
    const count = (tenantId: string | null) => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_ingest_rls_probe')
      if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
      const rows = await tx.$queryRawUnsafe<Array<{ runs: bigint; rates: bigint; allotments: bigint; policies: bigint }>>(
        'SELECT (SELECT count(*) FROM "SupplierIngestRun") AS runs, (SELECT count(*) FROM "SupplierRateObservation") AS rates, (SELECT count(*) FROM "SupplierAllotmentObservation") AS allotments, (SELECT count(*) FROM "SupplierCancellationObservation") AS policies')
      return rows[0]
    })
    const own = await count(tenantA)
    expect(Number(own.runs)).toBeGreaterThan(0); expect(Number(own.rates)).toBeGreaterThan(0); expect(Number(own.allotments)).toBeGreaterThan(0); expect(Number(own.policies)).toBeGreaterThan(0)
    for (const other of [await count(tenantB), await count(null)]) expect([other.runs, other.rates, other.allotments, other.policies].map(Number)).toEqual([0, 0, 0, 0])
  })
})
