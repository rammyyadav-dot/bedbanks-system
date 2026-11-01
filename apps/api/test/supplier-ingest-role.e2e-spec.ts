import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import type { IngestAllotment, IngestCancellationPolicy, IngestRate, IngestResult } from '@bedbanks/connectors-core'
import { PrismaService } from '../src/database/prisma.service'
import { INGEST_PROBES, certifyIngestRole, deprovisionIngestRole, ingestGrantStatements, provisionIngestRole } from '../src/database/supplier-ingest-role'
import { persistAllotments, persistCancellationPolicies, persistRates, type PersistScope } from '../src/supplier-ingest/ingest-persistence'
import { SupplierIngestDatabase } from '../src/supplier-ingest/supplier-ingest.database'

jest.setTimeout(120_000)

/** ADR 0079: supplier ingestion written end to end as the narrow `fbeds_ingest` login against PostgreSQL. */
describe('supplier ingestion under its narrow database role (ADR 0079, PostgreSQL)', () => {
  const owner = new PrismaService()
  const suffix = `ingrole-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  const loginRole = `fbeds_ingest_t${randomBytes(4).toString('hex')}`
  let narrow: PrismaClient
  let database: SupplierIngestDatabase
  let tenantA = '', tenantB = '', supplierA = '', connA = ''
  const t0 = new Date('2027-01-10T10:00:00.000Z')
  const scope = (key: string, patch: Partial<PersistScope> = {}): PersistScope => ({
    tenantId: tenantA, supplierId: supplierA, connectorId: connA, idempotencyKey: key, actorUserId: null, receivedAt: t0, sourceUpdatedAt: null, freshUntil: new Date(t0.getTime() + 3_600_000), ...patch,
  })
  const rate = (date: string, net: number): IngestRate => ({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: 'BAR', boardCode: 'BB', stayDate: date, currency: 'AED', netMinor: net, taxesIncluded: null, minStay: null, maxStay: null, closedToArrival: false, closedToDeparture: false })
  const complete = <T,>(accepted: T[]): IngestResult<T> => ({ accepted, rejected: [], extracted: accepted.length, status: 'COMPLETE' })

  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL as string)
    await provisionIngestRole(owner, { loginRole, password })
    const login = new URL(ownerUrl.toString()); login.username = loginRole; login.password = password
    narrow = new PrismaClient({ datasourceUrl: login.toString() })
    database = new SupplierIngestDatabase({ SUPPLIER_INGEST_DATABASE_URL: login.toString(), DATABASE_URL: ownerUrl.toString() })
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    supplierA = (await owner.supplier.create({ data: { tenantId: tenantA, type: 'DMC', legalName: `${suffix} LLC`, displayName: 'Ingest Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    connA = (await owner.connectorDefinition.create({ data: { tenantId: tenantA, supplierId: supplierA, type: 'XML_IN', status: 'ACTIVE', name: 'cm-a', version: '0.0.1' } })).id
  })

  afterAll(async () => {
    await database.onModuleDestroy()
    await narrow.$disconnect()
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('fbeds.ingest_erasure', 'on', true)`
      for (const id of [tenantA, tenantB]) {
        for (const table of ['SupplierRateObservation', 'SupplierAllotmentObservation', 'SupplierCancellationObservation', 'SupplierIngestRun']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM "AuditEvent" WHERE tenant_id = $1', id)
        await tx.$executeRawUnsafe('DELETE FROM "ConnectorDefinition" WHERE tenant_id = $1', id)
        await tx.$executeRawUnsafe('DELETE FROM "Supplier" WHERE tenant_id = $1', id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      }
    })
    await deprovisionIngestRole(owner, loginRole)
    await owner.$disconnect()
  })

  it('ROLE-CERTIFY: the login passes the catalogue verifier and every privilege probe', async () => {
    const report = await certifyIngestRole(narrow)
    expect(report.role.failures).toEqual([])
    expect(report.probes.filter((p) => !p.ok)).toEqual([])
    expect(report.probes).toHaveLength(INGEST_PROBES.length)
    const grants = ingestGrantStatements().join('\n')
    expect(grants).not.toMatch(/GRANT (UPDATE|DELETE)[A-Z, ]* ON "(SupplierIngestRun)"/)
    expect(grants).not.toMatch(/ON "(users|sessions|DailyRate|DailyAvailability|CancellationPolicy|ConnectorCredentialReference)"/)
  })

  it('WRITE: the role persists rates, allotments and policies with a SYSTEM audit event, and replays idempotently', async () => {
    const r = complete([rate('2027-03-05', 41250), rate('2027-03-06', 40000)])
    const first = await database.withTenant(tenantA, (tx) => persistRates(tx, scope('role-rates-0001'), r))
    expect(first).toMatchObject({ status: 'COMPLETE', applied: true, replayed: false, written: 2 })
    expect(await database.withTenant(tenantA, (tx) => persistRates(tx, scope('role-rates-0001'), r))).toMatchObject({ replayed: true, written: 0 })
    const newer = await database.withTenant(tenantA, (tx) => persistRates(tx, scope('role-rates-0002', { receivedAt: new Date(t0.getTime() + 60_000), freshUntil: new Date(t0.getTime() + 7_200_000) }), complete([rate('2027-03-05', 45000)])))
    expect(newer.written).toBe(1)
    const older = await database.withTenant(tenantA, (tx) => persistRates(tx, scope('role-rates-0003', { receivedAt: new Date(t0.getTime() - 60_000) }), complete([rate('2027-03-05', 1)])))
    expect(older).toMatchObject({ written: 0, superseded: 1 })
    expect((await owner.supplierRateObservation.findFirstOrThrow({ where: { tenantId: tenantA, stayDate: new Date('2027-03-05') } })).netMinor).toBe(45000n)

    const a: IngestAllotment[] = [{ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: null, stayDate: '2027-03-05', mode: 'ALLOTMENT', available: 4, stopSell: false, releaseDays: 3 }]
    expect((await database.withTenant(tenantA, (tx) => persistAllotments(tx, scope('role-allot-0001'), complete(a)))).written).toBe(1)
    const p: IngestCancellationPolicy[] = [{ supplierHotelCode: 'H1', supplierRoomCode: null, supplierRatePlanCode: 'BAR', nonRefundable: true, windows: [{ from: '2027-03-01T00:00:00.000Z', penalty: { type: 'FULL' } }] }]
    expect((await database.withTenant(tenantA, (tx) => persistCancellationPolicies(tx, scope('role-canc-00001'), complete(p)))).written).toBe(1)

    const audits = await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityType: 'supplier_ingest_run' } })
    expect(audits.length).toBeGreaterThanOrEqual(5)
    expect(audits.every((e) => e.actorType === 'SYSTEM' && e.userId === null && e.action === 'supplier.ingest.complete')).toBe(true)
  })

  // A missing privilege surfaces as the sanitized, typed 503 (never the database message); a row-level-security refusal is a plain error.
  const refused = { response: { code: 'SUPPLIER_INGEST_UNAVAILABLE' } }

  it('DENY: the role cannot forge other audit actions, write another tenant, edit evidence or identity, or touch contracted inventory', async () => {
    const audit = (tenantId: string, action: string, entityType = 'supplier_ingest_run') => database.withTenant(tenantA, (tx) =>
      tx.auditEvent.createMany({ data: [{ tenantId, userId: null, actorType: 'SYSTEM', action, entityType, entityId: 'x', payload: {} }] }))
    await expect(audit(tenantA, 'booking.finance.posted', 'booking')).rejects.toThrow(/row-level security|violates/i)
    await expect(audit(tenantA, 'supplier.ingest.complete', 'booking')).rejects.toThrow(/row-level security|violates/i)
    await expect(audit(tenantB, 'supplier.ingest.complete')).rejects.toThrow(/row-level security|violates/i)
    await expect(database.withTenant(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "SupplierIngestRun" SET "status" = 'FAILED'`))).rejects.toMatchObject(refused)
    await expect(database.withTenant(tenantA, (tx) => tx.$executeRawUnsafe(`DELETE FROM "SupplierRateObservation"`))).rejects.toMatchObject(refused)
    await expect(database.withTenant(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "SupplierRateObservation" SET "supplier_hotel_code" = 'X'`))).rejects.toMatchObject(refused)
    await expect(database.withTenant(tenantA, (tx) => tx.$executeRawUnsafe(`INSERT INTO "DailyRate" ("id") VALUES ('x')`))).rejects.toMatchObject(refused)
    await expect(database.withTenant(tenantA, (tx) => tx.$queryRawUnsafe(`SELECT "id" FROM "DailyAvailability"`))).rejects.toMatchObject(refused)
  })

  it('ISOLATION: another tenant context sees none of tenant A\'s ingestion rows, and cannot use tenant A\'s connector', async () => {
    const counts = await database.withTenant(tenantB, async (tx) => (await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT (SELECT count(*) FROM "SupplierIngestRun") + (SELECT count(*) FROM "SupplierRateObservation") AS n`))[0].n)
    expect(Number(counts)).toBe(0)
    await expect(database.withTenant(tenantB, (tx) => persistRates(tx, scope('role-foreign-01', { tenantId: tenantB }), complete([rate('2027-03-05', 100)])))).rejects.toMatchObject({ code: 'CONNECTOR_NOT_ACTIVE' })
  })

  it('CONFIG: an unconfigured connection, or one equal to DATABASE_URL, refuses with a typed 503 before connecting', async () => {
    for (const env of [{}, { SUPPLIER_INGEST_DATABASE_URL: 'postgresql://x@h/db', DATABASE_URL: 'postgresql://x@h/db' }]) {
      const unconfigured = new SupplierIngestDatabase(env)
      await expect(unconfigured.withTenant(tenantA, async () => 1)).rejects.toMatchObject({ response: { code: 'SUPPLIER_INGEST_UNAVAILABLE' } })
    }
  })
})
