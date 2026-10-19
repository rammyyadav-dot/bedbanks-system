import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { FileSystemComplianceArchive, sha256Hex, type ArchiveObject, type ComplianceArchive } from '../src/compliance/compliance-archive'
import { PLATFORM_SCOPE, dueScopes, exportScope, inScope, knownScopes, manifestKey, type BatchManifest } from '../src/compliance/compliance-export'
import { deprovisionComplianceRole, provisionComplianceRole, verifyComplianceRole } from '../src/compliance/compliance-role'
import { verifyArchiveChain, verifyArchivedBatch, verifyScope } from '../src/compliance/compliance-verify'
import { LocalComplianceSigner, storedHeads, verifyCheckpoints, writeCheckpoint } from '../src/compliance/compliance-anchor'
import { withCredentials } from '../src/database/ops-database-url'

/**
 * ADR 0067 on real PostgreSQL: the capture trigger, its classification and jurisdiction, immutability, row-level security of the compliance tables,
 * the restricted compliance role, and the hash-chained export to a write-once archive (filesystem adapter; S3 Object Lock is covered by the unit spec).
 */
const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')

const LOGIN = 'fbeds_compliance_e2e'
const WRITER = 'fbeds_compliance_e2e_writer'
const password = randomBytes(24).toString('base64url')
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe('Compliance reporting hooks (ADR 0067)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  let compliance: PrismaClient
  let archiveDir: string
  let archive: FileSystemComplianceArchive
  let tenantId: string
  let otherTenantId: string
  let userId: string
  let hotelId: string
  let agencyId: string
  let domesticAgencyId: string
  let n = 0

  /** Inserts an audit event the way a restricted application role does: SET ROLE to a role that holds only INSERT on AuditEvent, inside the tenant. */
  async function audit(tenant: string | null, action: string, entity: { type?: string; id?: string } = {}, payload: Record<string, unknown> = { requestId: `r-${n}` }, options: { rollback?: boolean } = {}): Promise<string> {
    const id = `e2e-ce-${suffix}-${++n}`
    const work = owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${WRITER}"`)
      if (tenant) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`
      else await tx.$executeRaw`SELECT set_config('app.platform_access', 'true', true)` // as PrismaService.withPlatform
      await tx.$executeRaw`INSERT INTO "AuditEvent" ("id", "tenant_id", "user_id", "actor_type", "action", "entity_type", "entity_id", "payload")
        VALUES (${id}, ${tenant}, ${userId}, 'USER'::"AuditActorType", ${action}, ${entity.type ?? 'fixture'}, ${entity.id ?? id}, ${JSON.stringify(payload)}::jsonb)`
      if (options.rollback) throw new Error('rollback')
    })
    if (options.rollback) await expect(work).rejects.toThrow('rollback')
    else await work
    return id
  }

  beforeAll(async () => {
    const tenant = await owner.tenant.create({ data: { name: `Compliance ${suffix}`, slug: `compliance-${suffix}` } })
    const other = await owner.tenant.create({ data: { name: `Compliance other ${suffix}`, slug: `compliance-other-${suffix}` } })
    tenantId = tenant.id; otherTenantId = other.id
    userId = (await owner.user.create({ data: { email: `compliance-${suffix}@example.test`, name: 'Compliance fixture' } })).id
    hotelId = (await owner.hotel.create({ data: { tenantId, name: `Compliance hotel ${suffix}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    agencyId = (await owner.agency.create({ data: { tenantId, code: `GB-${suffix}`.toUpperCase(), name: 'UK agency', countryCode: 'GB', createdById: userId } })).id
    domesticAgencyId = (await owner.agency.create({ data: { tenantId, code: `AE-${suffix}`.toUpperCase(), name: 'Local agency', countryCode: 'AE', createdById: userId } })).id
    await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WRITER}') THEN CREATE ROLE "${WRITER}" NOLOGIN; END IF; END $$`)
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${WRITER}"`)
    await owner.$executeRawUnsafe(`GRANT INSERT ON "AuditEvent" TO "${WRITER}"`)
    await provisionComplianceRole(owner, { loginRole: LOGIN, password })
    compliance = new PrismaClient({ datasourceUrl: withCredentials(ownerUrl!, LOGIN, password) })
    archiveDir = await mkdtemp(join(tmpdir(), 'fbeds-compliance-'))
    archive = new FileSystemComplianceArchive(archiveDir)
  })

  afterAll(async () => {
    await compliance?.$disconnect()
    await deprovisionComplianceRole(owner, LOGIN)
    await owner.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WRITER}') THEN REVOKE ALL ON "AuditEvent" FROM "${WRITER}"; REVOKE USAGE ON SCHEMA public FROM "${WRITER}"; DROP ROLE "${WRITER}"; END IF; END $$`)
    await owner.booking.deleteMany({ where: { tenantId } })
    await owner.agency.deleteMany({ where: { tenantId } })
    await owner.hotel.deleteMany({ where: { tenantId } })
    await owner.auditEvent.deleteMany({ where: { id: { startsWith: `e2e-ce-${suffix}` } } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await owner.user.deleteMany({ where: { id: userId } })
    await owner.$disconnect()
    if (archiveDir) await rm(archiveDir, { recursive: true, force: true })
  })

  it('the provisioned compliance role is restricted and holds exactly its privileges', async () => {
    await expect(verifyComplianceRole(compliance)).resolves.toEqual({ ok: true, failures: [] })
  })

  it('captures a classified audit event in its own transaction, with the payload digest, and ignores unclassified ones', async () => {
    const payload = { requestId: 'rq-1', permission: 'dashboard.read', nested: { b: 2, a: 1 } }
    const denied = await audit(tenantId, 'permission.denied', { type: 'admin_permission', id: 'dashboard.read' }, payload)
    const ignored = await audit(tenantId, 'hotel.search')
    const record = await owner.complianceRecord.findUnique({ where: { id: denied } })
    expect(record).toMatchObject({ tenantId, category: 'ACCESS_DENIAL', action: 'permission.denied', entityType: 'admin_permission', entityId: 'dashboard.read', actorType: 'USER', userId, crossBorder: null })
    const [{ text }] = await owner.$queryRaw<Array<{ text: string }>>`SELECT "payload"::text AS text FROM "AuditEvent" WHERE "id" = ${denied}`
    expect(record!.payloadSha256).toBe(sha256Hex(text))
    expect(await owner.complianceRecord.findUnique({ where: { id: ignored } })).toBeNull()
  })

  it('a rolled-back mutation leaves neither its audit event nor a compliance record', async () => {
    const id = await audit(tenantId, 'platform.role.assigned', {}, {}, { rollback: true })
    expect(await owner.auditEvent.findUnique({ where: { id } })).toBeNull()
    expect(await owner.complianceRecord.findUnique({ where: { id } })).toBeNull()
  })

  it('records the buyer and destination countries of a booking event and flags a cross-border booking', async () => {
    const booking = (agency: string, ref: string) => owner.booking.create({ data: { tenantId, reference: `CE-${ref}-${suffix}`, supplier: 'fixture', hotelId, agencyId: agency, currency: 'AED', totalMinor: 100000n, idempotencyKey: `ce-${ref}-${suffix}`, searchSnapshot: {} } })
    const cross = await booking(agencyId, 'cross')
    const domestic = await booking(domesticAgencyId, 'dom')
    const a = await audit(tenantId, 'booking.confirmed', { type: 'booking', id: cross.id })
    const b = await audit(tenantId, 'booking.cancelled', { type: 'booking', id: domestic.id })
    const c = await audit(tenantId, 'booking.confirmed', { type: 'booking', id: 'no-such-booking' })
    expect(await owner.complianceRecord.findUnique({ where: { id: a } })).toMatchObject({ category: 'BOOKING_JURISDICTION', originCountry: 'GB', destinationCountry: 'AE', crossBorder: true })
    expect(await owner.complianceRecord.findUnique({ where: { id: b } })).toMatchObject({ originCountry: 'AE', destinationCountry: 'AE', crossBorder: false })
    expect(await owner.complianceRecord.findUnique({ where: { id: c } })).toMatchObject({ originCountry: null, destinationCountry: null, crossBorder: null })
  })

  it('compliance records are append-only, even for the owner', async () => {
    const id = await audit(tenantId, 'settings.updated')
    await expect(owner.$executeRaw`UPDATE "ComplianceRecord" SET "action" = 'tampered' WHERE "id" = ${id}`).rejects.toThrow(/append-only/)
    await expect(owner.$executeRaw`DELETE FROM "ComplianceRecord" WHERE "id" = ${id}`).rejects.toThrow(/append-only/)
  })

  it('no role but the capture trigger can insert a compliance record, and the compliance role sees one scope at a time', async () => {
    await expect(compliance.$executeRaw`INSERT INTO "ComplianceRecord" ("id", "category", "action", "entity_type", "entity_id", "actor_type", "occurred_at", "payload", "payload_sha256")
      VALUES ('forged', 'RBAC_CHANGE', 'x', 'x', 'x', 'USER', now(), '{}', ${'0'.repeat(64)})`).rejects.toThrow(/permission denied/)
    const mine = await audit(tenantId, 'agency.member.added')
    const theirs = await audit(otherTenantId, 'agency.member.added')
    const platform = await audit(null, 'platform.role.created')
    const seen = async (scope: string | null) => (scope === null
      ? compliance.complianceRecord.findMany({ where: { id: { in: [mine, theirs, platform] } }, select: { id: true } })
      : inScope(compliance, scope, (tx) => tx.complianceRecord.findMany({ where: { id: { in: [mine, theirs, platform] } }, select: { id: true } }))).then((rows) => rows.map((r) => r.id))
    expect(await seen(null)).toEqual([])
    expect(await seen(tenantId)).toEqual([mine])
    expect(await seen(otherTenantId)).toEqual([theirs])
    expect(await seen(PLATFORM_SCOPE)).toEqual([platform])
    expect(await dueScopes(compliance)).toEqual(expect.arrayContaining([tenantId, otherTenantId, PLATFORM_SCOPE]))
  })

  it('exports a scope into hash-chained, write-once batches that verify from the archive alone', async () => {
    const first = await exportScope(compliance, tenantId, { archive, batchSize: 3 })
    expect(first.stored.length).toBeGreaterThanOrEqual(2)
    expect(first.stored.map((b) => b.sequence)).toEqual(first.stored.map((_, i) => i + 1))
    expect(await dueScopes(compliance)).not.toContain(tenantId)
    expect((await exportScope(compliance, tenantId, { archive })).stored).toEqual([])

    const later = await audit(tenantId, 'hotel.exported')
    const second = await exportScope(compliance, tenantId, { archive })
    expect(second.stored).toHaveLength(1)
    const head = await owner.complianceExportBatch.findFirstOrThrow({ where: { scopeKey: tenantId }, orderBy: { sequence: 'desc' } })
    const previous = await owner.complianceExportBatch.findFirstOrThrow({ where: { scopeKey: tenantId, sequence: head.sequence - 1 } })
    expect(head).toMatchObject({ storageStatus: 'STORED', previousSha256: previous.batchSha256, recordCount: 1 })
    expect(await owner.complianceExportBatchRecord.findUnique({ where: { recordId: later } })).toMatchObject({ batchId: head.id, position: 1 })

    const chain = await verifyArchiveChain(archive, tenantId)
    expect(chain).toMatchObject({ batches: head.sequence, headSha256: head.batchSha256, failures: [] })
    const report = await verifyScope(compliance, archive, tenantId)
    expect(report).toMatchObject({ failures: [], sealedNotStored: 0, skippedBehindChain: 0, overdue: 0 })
    const ids = (await readFile(join(archiveDir, ...head.objectKey.split('/')), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id)
    expect(ids).toEqual([later])
  })

  it('detects a tampered, missing or reordered batch', async () => {
    const batches = await owner.complianceExportBatch.findMany({ where: { scopeKey: tenantId }, orderBy: { sequence: 'asc' } })
    const manifest = JSON.parse(await readFile(join(archiveDir, ...manifestKey(batches[0].objectKey).split('/')), 'utf8')) as BatchManifest
    const body = await readFile(join(archiveDir, ...batches[0].objectKey.split('/')))
    expect(verifyArchivedBatch(manifest, body, '0'.repeat(64), 1).failures).toEqual([])
    const edited = Buffer.from(body.toString('utf8').replace('"USER"', '"SYSTEM"'))
    expect(verifyArchivedBatch(manifest, edited, '0'.repeat(64), 1).failures).toEqual(expect.arrayContaining([expect.stringMatching(/body hash/)]))
    expect(verifyArchivedBatch(manifest, null, '0'.repeat(64), 1).failures).toEqual(expect.arrayContaining([expect.stringMatching(/missing/)]))
    expect(verifyArchivedBatch({ ...manifest, sequence: 2 }, body, '0'.repeat(64), 1).failures.length).toBeGreaterThan(0)

    // Tampering with the stored object itself is caught by both verifiers.
    const path = join(archiveDir, ...batches[0].objectKey.split('/'))
    await chmod(path, 0o644); await writeFile(path, edited)
    try {
      expect((await verifyArchiveChain(archive, tenantId)).failures).toEqual(expect.arrayContaining([expect.stringMatching(/body hash/)]))
      expect((await verifyScope(compliance, archive, tenantId)).failures.length).toBeGreaterThan(0)
    } finally { await writeFile(path, body); await chmod(path, 0o444) }
  })

  it('a batch sealed but not stored (crash, storage outage) is stored first on the next run, with the same hash', async () => {
    const failing: ComplianceArchive = { description: 'failing', immutable: false, assertReady: async () => undefined, get: (k) => archive.get(k), list: (p) => archive.list(p),
      put: async (_o: ArchiveObject) => { throw new Error('storage unavailable') } }
    const pending = await audit(tenantId, 'funding.posted')
    await expect(exportScope(compliance, tenantId, { archive: failing })).rejects.toThrow('storage unavailable')
    const sealed = await owner.complianceExportBatch.findFirstOrThrow({ where: { scopeKey: tenantId, storageStatus: 'SEALED' } })
    expect((await verifyScope(compliance, archive, tenantId)).sealedNotStored).toBe(1)
    await audit(tenantId, 'funding.verified')
    const resumed = await exportScope(compliance, tenantId, { archive })
    expect(resumed.stored[0]).toMatchObject({ sequence: sealed.sequence, batchSha256: sealed.batchSha256 })
    expect(resumed.stored).toHaveLength(2)
    expect(await owner.complianceExportBatchRecord.findUnique({ where: { recordId: pending } })).toMatchObject({ batchId: sealed.id })
    expect((await verifyScope(compliance, archive, tenantId)).failures).toEqual([])
  })

  it('a batch can only move SEALED -> STORED once, and is never deleted', async () => {
    const stored = await owner.complianceExportBatch.findFirstOrThrow({ where: { scopeKey: tenantId, storageStatus: 'STORED' } })
    await expect(owner.$executeRaw`UPDATE "ComplianceExportBatch" SET "storage_status" = 'SEALED', "stored_at" = NULL WHERE "id" = ${stored.id}`).rejects.toThrow(/SEALED -> STORED/)
    await expect(owner.$executeRaw`UPDATE "ComplianceExportBatch" SET "body_sha256" = ${'f'.repeat(64)} WHERE "id" = ${stored.id}`).rejects.toThrow(/SEALED -> STORED/)
    await expect(owner.$executeRaw`DELETE FROM "ComplianceExportBatch" WHERE "id" = ${stored.id}`).rejects.toThrow(/append-only/)
    await expect(inScope(compliance, tenantId, (tx) => tx.$executeRaw`UPDATE "ComplianceExportBatch" SET "record_count" = 1 WHERE "id" = ${stored.id}`)).rejects.toThrow(/permission denied/)
    await expect(inScope(compliance, tenantId, (tx) => tx.$executeRaw`DELETE FROM "ComplianceExportBatchRecord" WHERE "batch_id" = ${stored.id}`)).rejects.toThrow(/permission denied/)
  })

  it('exports the tenantless platform scope separately', async () => {
    const platform = await audit(null, 'platform.role.revoked')
    await exportScope(compliance, PLATFORM_SCOPE, { archive })
    const membership = await owner.complianceExportBatchRecord.findUniqueOrThrow({ where: { recordId: platform }, include: { batch: true } })
    expect(membership.batch).toMatchObject({ scopeKey: PLATFORM_SCOPE, tenantId: null, storageStatus: 'STORED' })
    const manifest = JSON.parse(await readFile(join(archiveDir, ...manifestKey(membership.batch.objectKey).split('/')), 'utf8')) as BatchManifest
    const body = await readFile(join(archiveDir, ...membership.batch.objectKey.split('/')))
    expect(verifyArchivedBatch(manifest, body, membership.batch.previousSha256, membership.batch.sequence).failures).toEqual([])
    expect(await knownScopes(compliance)).toEqual(expect.arrayContaining([PLATFORM_SCOPE, tenantId]))
  })

  it('signs a checkpoint of the stored chain heads read through the compliance role, verifiable against the archive (amendment 4)', async () => {
    const heads = await storedHeads(compliance)
    const mine = heads.find((h) => h.scope === tenantId)
    const head = await owner.complianceExportBatch.findFirstOrThrow({ where: { scopeKey: tenantId, storageStatus: 'STORED' }, orderBy: { sequence: 'desc' } })
    expect(mine).toEqual({ scope: tenantId, headSequence: head.sequence, headSha256: head.batchSha256 })
    // Other suites share this database; sign this tenant's head only, against this test's archive.
    const signer = new LocalComplianceSigner()
    const checkpoint = await writeCheckpoint(archive, signer, [mine!], { retainUntil: new Date(Date.now() + 365 * 86_400_000) })
    expect(checkpoint?.checkpoint.scopes).toEqual([mine])
    const chain = await verifyArchiveChain(archive, tenantId)
    expect(await verifyCheckpoints(archive, new Map([[tenantId, chain.hashes]]))).toMatchObject({ checkpoints: 1, failures: [] })
  })
})
