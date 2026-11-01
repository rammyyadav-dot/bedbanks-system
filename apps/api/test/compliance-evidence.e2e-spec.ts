import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { COMPLIANCE_CATEGORY_VALUES, COMPLIANCE_REPORT_MAX_RECORDS, type ComplianceRecordPage, type ComplianceReport, type ComplianceSummary } from '@bedbanks/contracts'
import { recordsSha256 } from '../src/admin-operations/compliance-report'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'
import { withCredentials } from '../src/database/ops-database-url'
import { FileSystemComplianceArchive } from '../src/compliance/compliance-archive'
import { exportScope } from '../src/compliance/compliance-export'
import { deprovisionComplianceRole, provisionComplianceRole } from '../src/compliance/compliance-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0067 amendment 1: the Admin compliance evidence API, with the whole application on the provisioned strict runtime role. Proves the
 * column-level grant is sufficient (no payload column is readable), the audit.read permission gate, tenant isolation by RLS (no other tenant's
 * and no platform record), the jurisdiction counts and the export state of each record after a real export.
 */
describe('Admin compliance evidence (strict runtime role, PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `ce-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'compliance-evidence-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const compliancePassword = randomBytes(24).toString('base64url')
  const COMPLIANCE_LOGIN = 'fbeds_compliance_ev_e2e'
  const SECRET = 'PAYLOAD-SECRET-MARKER'
  const origin = 'http://localhost:3001'
  let app: INestApplication
  let compliance: PrismaClient
  let archiveDir = ''
  let previousUrl: string | undefined
  let tenantA = ''; let tenantB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const emails: Record<string, string> = {}
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}
  let n = 0

  /** Audit events are inserted by the owner; the capture trigger turns the classified ones into compliance records. */
  async function audit(label: string, tenantId: string | null, action: string, entity: { type: string; id: string }, occurredAt = new Date()) {
    const id = `${suffix}-ae-${++n}`
    await owner.auditEvent.create({ data: { id, tenantId, userId: userIds[0], actorType: 'USER', action, entityType: entity.type, entityId: entity.id, payload: { requestId: id, note: SECRET }, createdAt: occurredAt } })
    ids[label] = id
  }

  beforeAll(async () => {
    const passwordHash = await hashPassword(password)
    tenantA = (await owner.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const auditRead = await owner.permission.upsert({ where: { key: 'audit.read' }, update: {}, create: { key: 'audit.read', description: 'audit.read' } })
    async function user(key: string, tenantId: string, permissionIds: string[]) {
      const role = await owner.role.create({ data: { tenantId, name: `${suffix}-${key}` } }); roleIds.push(role.id)
      if (permissionIds.length) await owner.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })) })
      const email = `${suffix}-${key}@example.test`; emails[key] = email
      const created = await owner.user.create({ data: { email, passwordHash, name: key } }); userIds.push(created.id)
      await owner.membership.create({ data: { tenantId, userId: created.id, role: 'member' } })
      await owner.userRole.create({ data: { tenantId, userId: created.id, roleId: role.id } })
    }
    await user('auditor', tenantA, [auditRead.id])
    await user('viewer', tenantA, [])
    await user('bauditor', tenantB, [auditRead.id])

    const hotel = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    const agency = (code: string, countryCode: string | null) => owner.agency.create({ data: { tenantId: tenantA, code: `${code}${randomBytes(3).toString('hex').toUpperCase()}`, name: code, countryCode, createdById: userIds[0] } })
    const [gb, ae, unknown] = await Promise.all([agency('GB', 'GB'), agency('AE', 'AE'), agency('XX', null)])
    const booking = (key: string, agencyId: string) => owner.booking.create({ data: { tenantId: tenantA, reference: `${suffix}-${key}`.toUpperCase(), supplier: 'fixture', hotelId: hotel, agencyId, currency: 'AED', totalMinor: 1000n, idempotencyKey: `${suffix}-${key}`, searchSnapshot: {} } })
    const bookings = { cross: await booking('cross', gb.id), dom: await booking('dom', ae.id), unk: await booking('unk', unknown.id) }

    const old = new Date(Date.now() - 2 * 86_400_000)
    await audit('denied', tenantA, 'permission.denied', { type: 'admin_permission', id: 'finance.read' }, old)
    await audit('rbac', tenantA, 'agency.member.added', { type: 'agency', id: gb.id }, old)
    await audit('cross', tenantA, 'booking.confirmed', { type: 'booking', id: bookings.cross.id })
    await audit('dom', tenantA, 'booking.confirmed', { type: 'booking', id: bookings.dom.id })
    await audit('unk', tenantA, 'booking.cancelled', { type: 'booking', id: bookings.unk.id })
    await audit('export', tenantA, 'hotel.exported', { type: 'hotel_directory', id: 'csv' })
    await audit('ignored', tenantA, 'hotel.search', { type: 'hotel', id: hotel })
    await audit('other', tenantB, 'permission.denied', { type: 'admin_permission', id: 'finance.read' })
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_access', 'true', true)`
      await tx.auditEvent.create({ data: { id: `${suffix}-platform`, tenantId: null, userId: userIds[0], actorType: 'USER', action: 'platform.role.created', entityType: 'platform_role', entityId: 'r', payload: {} } })
    })

    // Export the two oldest records of tenant A into one stored batch, so the view has every export state to show.
    await provisionComplianceRole(owner, { loginRole: COMPLIANCE_LOGIN, password: compliancePassword })
    compliance = new PrismaClient({ datasourceUrl: withCredentials(ownerUrl!, COMPLIANCE_LOGIN, compliancePassword) })
    archiveDir = await mkdtemp(join(tmpdir(), 'fbeds-compliance-ev-'))
    await exportScope(compliance, tenantA, { archive: new FileSystemComplianceArchive(archiveDir), batchSize: 2, maxBatchesPerScope: 1 })

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = withCredentials(ownerUrl!, API_RUNTIME_LOGIN_ROLE, runtimePassword); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const key of ['auditor', 'viewer', 'bauditor']) {
      const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: emails[key], password }).expect(200)
      cookies[key] = (response.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await compliance?.$disconnect()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    await deprovisionComplianceRole(owner, COMPLIANCE_LOGIN)
    const tenants = [tenantA, tenantB]
    await owner.booking.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.agency.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.hotel.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.auditEvent.deleteMany({ where: { OR: [{ tenantId: { in: tenants } }, { id: { startsWith: suffix } }] } })
    await owner.session.deleteMany({ where: { userId: { in: userIds } } })
    await owner.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await owner.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await owner.role.deleteMany({ where: { id: { in: roleIds } } })
    await owner.membership.deleteMany({ where: { userId: { in: userIds } } })
    await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: { in: tenants } } })
    await owner.$disconnect()
    if (archiveDir) await rm(archiveDir, { recursive: true, force: true })
  }, 60_000)

  const get = (who: string | null, path: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1/admin/operations/compliance${path}`).set('Origin', origin)
    return who ? r.set('Cookie', cookies[who]) : r
  }

  it('summarises the tenant\'s captured evidence, jurisdiction and export chain', async () => {
    const summary = (await get('auditor', '/summary?days=7').expect(200)).body.data as ComplianceSummary
    expect(summary.byCategory.map((c) => c.category)).toEqual([...COMPLIANCE_CATEGORY_VALUES])
    const count = (category: string) => summary.byCategory.find((c) => c.category === category)!.count
    expect({ denial: count('ACCESS_DENIAL'), rbac: count('RBAC_CHANGE'), booking: count('BOOKING_JURISDICTION'), export: count('DATA_EXPORT'), platform: count('PRIVILEGED_ACCESS') })
      .toEqual({ denial: 1, rbac: 1, booking: 3, export: 1, platform: 0 })
    expect(summary.bookings).toEqual({ crossBorder: 1, domestic: 1, unknown: 1 })
    expect(summary.export).toEqual({ state: 'available', data: expect.objectContaining({ batches: 1, stored: 1, sealedNotStored: 0, headSequence: 1, headSha256: expect.stringMatching(/^[0-9a-f]{64}$/), lastStoredAt: expect.any(String), pendingRecords: 4 }) })
  })

  it('lists records newest first with their export state, never the payload, and only the tenant\'s own', async () => {
    const page = (await get('auditor', '/records?pageSize=100').expect(200)).body.data as ComplianceRecordPage
    expect(page.total).toBe(6)
    expect(page.items.map((r) => r.id)).toEqual(expect.arrayContaining([ids.denied, ids.rbac, ids.cross, ids.dom, ids.unk, ids.export]))
    expect(page.items.map((r) => r.id)).not.toEqual(expect.arrayContaining([ids.ignored]))
    expect(page.items.some((r) => r.id === ids.other || r.id === `${suffix}-platform`)).toBe(false)
    const text = JSON.stringify(page)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('"payload"')
    const cross = page.items.find((r) => r.id === ids.cross)!
    expect(cross).toMatchObject({ category: 'BOOKING_JURISDICTION', originCountry: 'GB', destinationCountry: 'AE', crossBorder: true, exportState: 'PENDING', batchSequence: null, storedAt: null, payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(page.items.find((r) => r.id === ids.denied)).toMatchObject({ exportState: 'STORED', batchSequence: 1, storedAt: expect.any(String) })
    expect(page.items[0].occurredAt >= page.items[page.items.length - 1].occurredAt).toBe(true)

    const other = (await get('bauditor', '/records').expect(200)).body.data as ComplianceRecordPage
    expect(other.items.map((r) => r.id)).toEqual([ids.other])
  })

  it('filters by category, jurisdiction, export state, action and day, and rejects invalid filters', async () => {
    const list = async (query: string) => ((await get('auditor', `/records?${query}`).expect(200)).body.data as ComplianceRecordPage).items.map((r) => r.id).sort()
    expect(await list('category=BOOKING_JURISDICTION')).toEqual([ids.cross, ids.dom, ids.unk].sort())
    expect(await list('crossBorder=true')).toEqual([ids.cross])
    expect(await list('exportState=STORED')).toEqual([ids.denied, ids.rbac].sort())
    expect(await list('exportState=PENDING')).toHaveLength(4)
    expect(await list('exportState=SEALED')).toEqual([])
    expect(await list('action=hotel.exp')).toEqual([ids.export])
    expect(await list('action=%25')).toEqual([])
    const today = new Date().toISOString().slice(0, 10)
    expect(await list(`from=${today}&to=${today}`)).toHaveLength(4)
    await get('auditor', '/records?category=NOPE').expect(400)
    await get('auditor', '/records?exportState=LOST').expect(400)
    await get('auditor', '/records?from=2026-02-31').expect(400)
    await get('auditor', `/records?from=${today}&to=2000-01-01`).expect(400)
    await get('auditor', '/summary?days=91').expect(400)
  })

  // ---- per-period report (ADR 0067 amendment 3) ----
  const today = () => new Date().toISOString().slice(0, 10)
  const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const download = (who: string, query: string) => get(who, `/report?${query}`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))) })

  it('downloads the period report as JSON with counts, coverage and an attestation that matches the WORM archive', async () => {
    const res = await download('auditor', `from=${weekAgo()}&to=${today()}&format=json`).expect(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['content-disposition']).toBe(`attachment; filename="compliance-report-${weekAgo()}-to-${today()}.json"`)
    const report = JSON.parse((res.body as Buffer).toString('utf8')) as ComplianceReport
    expect(report).toMatchObject({ formatVersion: 1, tenantId: tenantA, period: { from: weekAgo(), to: today() }, generatedByUserId: userIds[0], totals: { records: 6, stored: 2, sealed: 0, pending: 4 } })
    expect(report.records.map((r) => r.id)).toEqual([ids.denied, ids.rbac, ids.cross, ids.dom, ids.unk, ids.export].sort((a, b) => (report.records.find((r) => r.id === a)!.occurredAt).localeCompare(report.records.find((r) => r.id === b)!.occurredAt) || a.localeCompare(b)))
    expect(report.bookings).toEqual({ crossBorder: 1, domestic: 1, unknown: 1, corridors: [{ origin: 'GB', destination: 'AE', count: 1 }] })
    expect(report.attestation.recordsSha256).toBe(recordsSha256(report.records))
    expect(res.headers['x-compliance-records-sha256']).toBe(report.attestation.recordsSha256)
    expect(JSON.stringify(report)).not.toContain(SECRET)
    // The stored records are byte-for-byte the archived ones: same ids and payload digests as the batch body in WORM storage.
    const batch = await owner.complianceExportBatch.findFirstOrThrow({ where: { scopeKey: tenantA, sequence: 1 } })
    expect(report.attestation.chainHead).toEqual({ sequence: 1, batchSha256: batch.batchSha256, storageStatus: 'STORED', storedAt: expect.any(String) })
    const archived = (await readFile(join(archiveDir, ...batch.objectKey.split('/')), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; payloadSha256: string })
    const stored = report.records.filter((r) => r.exportState === 'STORED')
    expect(stored.map((r) => [r.id, r.payloadSha256])).toEqual(archived.map((a) => [a.id, a.payloadSha256]))
    expect(recordsSha256(stored)).toBe(recordsSha256(archived))
  })

  it('downloads the same period as a formula-safe CSV, and every download is itself audited as DATA_EXPORT evidence', async () => {
    const before = await owner.complianceRecord.count({ where: { tenantId: tenantA, action: 'compliance.report.exported' } })
    const res = await download('auditor', `from=${weekAgo()}&to=${today()}&format=csv`).expect(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    const csv = (res.body as Buffer).toString('utf8')
    const hash = res.headers['x-compliance-records-sha256'] as string
    expect(csv).toContain(`Records SHA-256,${hash}`)
    expect(csv).toContain(`Records,${res.headers['x-compliance-records']}`)
    expect(csv).toContain(ids.cross)
    expect(csv).not.toContain(SECRET)
    // The download was captured, in the same transaction, as DATA_EXPORT evidence naming exactly what was handed out.
    const exports = await owner.complianceRecord.findMany({ where: { tenantId: tenantA, action: 'compliance.report.exported' }, orderBy: { occurredAt: 'asc' } })
    expect(exports).toHaveLength(before + 1)
    expect(exports.every((r) => r.category === 'DATA_EXPORT')).toBe(true)
    const event = await owner.auditEvent.findFirstOrThrow({ where: { tenantId: tenantA, action: 'compliance.report.exported', payload: { path: ['recordsSha256'], equals: hash } } })
    expect(event).toMatchObject({ userId: userIds[0], entityType: 'compliance_report', entityId: `${weekAgo()}..${today()}` })
    expect(event.payload).toMatchObject({ format: 'csv', records: Number(res.headers['x-compliance-records']), chainHeadSequence: 1 })
  })

  it('validates the period and keeps the error envelope', async () => {
    await get('auditor', '/report').expect(400)
    await get('auditor', `/report?from=${today()}`).expect(400)
    await get('auditor', `/report?from=${today()}&to=${weekAgo()}`).expect(400)
    await get('auditor', '/report?from=2024-01-01&to=2025-12-31').expect(400)
    await get('auditor', `/report?from=${weekAgo()}&to=${today()}&format=xlsx`).expect(400)
    const denied = await get('viewer', `/report?from=${weekAgo()}&to=${today()}`).expect(403)
    expect(denied.body.success).toBe(false)
  })

  it('the strict runtime role can read every column the view needs and not the payload', async () => {
    const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      await expect(runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`
        return tx.$queryRaw`SELECT "payload" FROM "ComplianceRecord" LIMIT 1`
      })).rejects.toThrow(/permission denied/)
      await expect(runtime.$executeRaw`INSERT INTO "ComplianceExportBatchRecord" ("batch_id", "position", "record_id") VALUES ('x', 1, 'y')`).rejects.toThrow(/permission denied/)
    } finally { await runtime.$disconnect() }
  })

  it('requires a session and the audit.read permission, and the refusal itself becomes compliance evidence', async () => {
    const viewerDenials = async () => ((await get('auditor', '/records?category=ACCESS_DENIAL&pageSize=100').expect(200)).body.data as ComplianceRecordPage).items
      .filter((r) => r.action === 'permission.denied' && r.userId === userIds[1] && r.entityId === 'audit.read').length
    const before = await viewerDenials()
    await get(null, '/summary').expect(401)
    await get('viewer', '/summary').expect(403)
    await get('viewer', '/records').expect(403)
    expect(await viewerDenials()).toBe(before + 2)
  })

  it('refuses a period with more records than the report cap instead of truncating it', async () => {
    const day = new Date(Date.now() - 3 * 86_400_000)
    await owner.auditEvent.createMany({ data: Array.from({ length: COMPLIANCE_REPORT_MAX_RECORDS + 1 }, (_, i) => ({
      id: `${suffix}-bulk-${i}`, tenantId: tenantB, userId: userIds[2], actorType: 'USER' as const, action: 'permission.denied', entityType: 'admin_permission', entityId: 'x', payload: {}, createdAt: day,
    })) })
    const res = await get('bauditor', `/report?from=${day.toISOString().slice(0, 10)}&to=${day.toISOString().slice(0, 10)}`).expect(422)
    expect(res.body.error.code).toBe('COMPLIANCE_REPORT_TOO_LARGE')
    expect(await owner.auditEvent.count({ where: { tenantId: tenantB, action: 'compliance.report.exported' } })).toBe(0)
  }, 120_000)
})
