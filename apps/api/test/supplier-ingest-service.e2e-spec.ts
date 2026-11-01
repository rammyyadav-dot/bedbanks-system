import { randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { deprovisionIngestRole, provisionIngestRole } from '../src/database/supplier-ingest-role'
import type { FeedDelivery, FeedJob } from '../src/supplier-ingest/feed-ports'
import { IngestProfileRegistry } from '../src/supplier-ingest/ingest-profile'
import { SupplierIngestDatabase } from '../src/supplier-ingest/supplier-ingest.database'
import { IngestJobRefused, SupplierIngestService } from '../src/supplier-ingest/supplier-ingest.service'
import { SupplierIngestWorker } from '../src/supplier-ingest/supplier-ingest.worker'

jest.setTimeout(120_000)

/** ADR 0080: documents in, observations out, end to end as the narrow ingestion login. The profiles below are synthetic and exist only in this test. */
describe('supplier ingestion service and worker (ADR 0080, PostgreSQL)', () => {
  const owner = new PrismaService()
  const suffix = `ingsvc-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  const loginRole = `fbeds_ingest_s${randomBytes(4).toString('hex')}`
  const received = new Date('2027-01-10T10:00:00.000Z')
  let database: SupplierIngestDatabase
  let service: SupplierIngestService
  let tenantId = '', supplierId = '', connectorId = ''
  const profiles = new IngestProfileRegistry()

  profiles.register({
    key: 'synthetic-cm-json', format: 'json', freshnessMs: 3_600_000,
    specs: {
      RATES: { recordPath: 'hotels[].rooms[].days[]', fields: { hotelCode: { path: 'id', level: 0 }, roomCode: { path: 'code', level: 1 }, ratePlanCode: { path: 'plan' }, stayDate: { path: 'date' }, currency: { path: 'cur', level: 0 }, netAmount: { path: 'net' } } },
    },
  })
  profiles.register({
    key: 'synthetic-xml', format: 'xml', freshnessMs: 3_600_000, cancellation: { hotelUtcOffset: '+04:00', cutoffTime: '18:00' },
    specs: {
      ALLOTMENTS: { recordPath: ['Hotel', 'Room', 'Day'], fields: { hotelCode: { path: '@code', level: 0 }, roomCode: { path: '@code', level: 1 }, stayDate: { path: '@date' }, available: { path: '@avail' }, mode: { path: '@mode' } } },
      CANCELLATION_POLICIES: { recordPath: ['Hotel', 'Plan', 'Rule'], fields: { hotelCode: { path: '@code', level: 0 }, ratePlanCode: { path: '@code', level: 1 }, currency: { path: '@cur', level: 1 }, daysBefore: { path: '@days' }, arrivalDate: { path: '@arrival' }, penaltyType: { path: '@type' }, penaltyValue: { path: '@value' } } },
    },
  })

  const job = (kind: FeedJob['kind'], profileKey: string): FeedJob => ({ tenantId, supplierId, connectorId, profileKey, kind })
  const delivery = (deliveryId: string, body: string): FeedDelivery => ({ deliveryId, body, receivedAt: received, sourceUpdatedAt: null })
  const jsonRates = (days: object[]) => JSON.stringify({ hotels: [{ id: 'H1', cur: 'AED', rooms: [{ code: 'DBL', days }] }] })

  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL as string)
    await provisionIngestRole(owner, { loginRole, password })
    const login = new URL(ownerUrl.toString()); login.username = loginRole; login.password = password
    database = new SupplierIngestDatabase({ SUPPLIER_INGEST_DATABASE_URL: login.toString(), DATABASE_URL: ownerUrl.toString() })
    service = new SupplierIngestService(database, profiles)
    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    supplierId = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} LLC`, displayName: 'Svc Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    connectorId = (await owner.connectorDefinition.create({ data: { tenantId, supplierId, type: 'CHANNEL_MANAGER', status: 'ACTIVE', name: 'cm', version: '0.0.1' } })).id
  })

  afterAll(async () => {
    await database.onModuleDestroy()
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('fbeds.ingest_erasure', 'on', true)`
      for (const table of ['SupplierRateObservation', 'SupplierAllotmentObservation', 'SupplierCancellationObservation', 'SupplierIngestRun', 'AuditEvent', 'ConnectorDefinition', 'Supplier']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', tenantId)
    })
    await deprovisionIngestRole(owner, loginRole)
    await owner.$disconnect()
  })

  it('JSON channel-manager rates are normalized and applied; the same delivery replays; a republished id with other content is refused', async () => {
    const body = jsonRates([{ date: '2027-03-05', plan: 'BAR', net: '412.50' }, { date: '2027-03-06', plan: 'BAR', net: 400 }])
    const first = await service.ingest(job('RATES', 'synthetic-cm-json'), delivery('d-0001', body))
    expect(first).toMatchObject({ kind: 'RATES', status: 'COMPLETE', applied: true, replayed: false, written: 2, rejected: 0 })
    const rows = await owner.supplierRateObservation.findMany({ where: { tenantId }, orderBy: { stayDate: 'asc' } })
    expect(rows.map((r) => [r.supplierHotelCode, r.supplierRoomCode, r.netMinor, r.currency])).toEqual([['H1', 'DBL', 41250n, 'AED'], ['H1', 'DBL', 40000n, 'AED']])
    expect(await service.ingest(job('RATES', 'synthetic-cm-json'), delivery('d-0001', body))).toMatchObject({ replayed: true, written: 0 })
    await expect(service.ingest(job('RATES', 'synthetic-cm-json'), delivery('d-0001', jsonRates([{ date: '2027-03-05', plan: 'BAR', net: '1.00' }])))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('a partly invalid XML feed is recorded as PARTIAL evidence and applies nothing', async () => {
    const xml = `<Feed><Hotel code="H1"><Room code="DBL"><Day date="2027-03-05" avail="4"/><Day date="2027-03-06" avail="5"/><Day date="2027-03-07" avail="6"/><Day date="2027-03-08" avail="-1"/></Room></Hotel></Feed>`
    const out = await service.ingest(job('ALLOTMENTS', 'synthetic-xml'), delivery('d-0002', xml))
    expect(out).toMatchObject({ status: 'PARTIAL', applied: false, written: 0, rejected: 1, extracted: 4 })
    expect(await owner.supplierAllotmentObservation.count({ where: { tenantId } })).toBe(0)
    const run = await owner.supplierIngestRun.findFirstOrThrow({ where: { tenantId, id: out.runId } })
    expect(run.rejectSummary).toEqual({ 'invalid_integer:available': 1 })
  })

  it('an unreadable document (DOCTYPE) is recorded as a FAILED run and writes nothing', async () => {
    const out = await service.ingest(job('ALLOTMENTS', 'synthetic-xml'), delivery('d-0003', '<!DOCTYPE x [<!ENTITY a "b">]><Feed/>'))
    expect(out).toMatchObject({ status: 'FAILED', applied: false, extracted: 0, written: 0 })
    expect(await owner.supplierIngestRun.count({ where: { tenantId, id: out.runId, status: 'FAILED' } })).toBe(1)
    const json = await service.ingest(job('RATES', 'synthetic-cm-json'), delivery('d-0004', 'not json'))
    expect(json).toMatchObject({ status: 'FAILED', applied: false })
  })

  it('cancellation windows given as days-before-arrival use the profile\'s configured offset and cut-off', async () => {
    const xml = `<Feed><Hotel code="H1"><Plan code="BAR" cur="AED"><Rule days="14" arrival="2027-05-01" type="percent" value="50"/><Rule days="3" arrival="2027-05-01" type="full"/></Plan></Hotel></Feed>`
    const out = await service.ingest(job('CANCELLATION_POLICIES', 'synthetic-xml'), delivery('d-0005', xml))
    expect(out).toMatchObject({ status: 'COMPLETE', applied: true, written: 1 })
    const policy = await owner.supplierCancellationObservation.findFirstOrThrow({ where: { tenantId } })
    expect(policy.windows).toEqual([
      { from: '2027-04-17T14:00:00.000Z', penalty: { type: 'PERCENT', basisPoints: 5000 } },
      { from: '2027-04-28T14:00:00.000Z', penalty: { type: 'FULL' } }])
  })

  it('an unknown profile or an unsupported feed kind is refused before any run is recorded', async () => {
    const before = await owner.supplierIngestRun.count({ where: { tenantId } })
    await expect(service.ingest(job('RATES', 'nope-profile'), delivery('d-0006', '{}'))).rejects.toMatchObject({ code: 'PROFILE_UNKNOWN' })
    await expect(service.ingest(job('ALLOTMENTS', 'synthetic-cm-json'), delivery('d-0007', '{}'))).rejects.toBeInstanceOf(IngestJobRefused)
    expect(await owner.supplierIngestRun.count({ where: { tenantId } })).toBe(before)
  })

  it('the worker runs due jobs through the service, survives a failing job, and never overlaps itself', async () => {
    const fetched: string[] = []
    const jobs = [job('RATES', 'synthetic-cm-json'), job('RATES', 'synthetic-cm-json'), job('RATES', 'synthetic-cm-json')]
    const worker = new SupplierIngestWorker(database, service, profiles,
      { dueJobs: async () => jobs },
      { fetch: async () => { const n = fetched.push('x'); if (n === 2) throw new Error('boom'); return delivery(`w-000${n}`, jsonRates([{ date: `2027-04-0${n}`, plan: 'BAR', net: '10.00' }])) } },
      {})
    const pass = worker.runOnce()
    expect(await worker.runOnce()).toBe(0) // overlapping pass is a no-op
    expect(await pass).toBe(2)
    expect(fetched).toHaveLength(3)
    expect(await owner.supplierRateObservation.count({ where: { tenantId, stayDate: { in: [new Date('2027-04-01'), new Date('2027-04-03')] } } })).toBe(2)
  })
})
