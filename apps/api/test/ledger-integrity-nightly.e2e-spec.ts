import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { LEDGER_AUDIT_GROUP_ROLE, provisionLedgerAuditRole, deprovisionLedgerAuditRole, verifyLedgerAuditRole } from '../src/database/ledger-audit-role'
import { LedgerIntegrityRunsService } from '../src/ledger/ledger-integrity-runs.service'
import { LedgerIntegritySweeper } from '../src/ledger/ledger-integrity-sweeper.service'
import { runDateUtc } from '../src/ledger/integrity-schedule'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'

jest.setTimeout(120_000)

/**
 * Nightly ledger integrity run (ADR 0064) against the real AppModule and PostgreSQL, through the real restricted role.
 * A: broken ledger, recorded tonight. B: clean, recorded tonight. C: only an old run (overdue). D: nothing yet (never run).
 */
describe('nightly ledger integrity run (PostgreSQL, HTTP, restricted role, four tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `ln-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'finance-audit-summary-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const at = (offsetDays: number, hours = 12) => new Date(midnight + offsetDays * 86_400_000 + hours * 3_600_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', tenantC = '', tenantD = '', walletAed = '', walletEur = '', walletB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}

  async function user(label: string, tenantId: string, permissionKeys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (permissionKeys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of permissionKeys) {
        const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return email
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const get = (path: string, who = 'both') => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  let seq = 0
  const entry = (tenantId: string, walletId: string, type: 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND', amountMinor: bigint, currency: string, when: Date) =>
    prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor, currency, reference: null, idempotencyKey: `${suffix}-${++seq}`, immutableAt: when } })

  const LOGIN = 'fbeds_ledger_audit_e2e'
  const LOGIN_PASSWORD = `lp_${randomBytes(20).toString('hex')}`
  const ownerUrl = process.env.DATABASE_URL as string
  const loginUrl = (() => { const u = new URL(ownerUrl); u.username = LOGIN; u.password = LOGIN_PASSWORD; return u.toString() })()
  const restricted = new PrismaClient({ datasourceUrl: loginUrl })
  const savedEnv: Record<string, string | undefined> = {}
  let runs: LedgerIntegrityRunsService, sweeper: LedgerIntegritySweeper
  const NOW = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00.000Z')
  const TODAY = runDateUtc(NOW)

  const chain = async (tenantId: string, walletId: string, id: string, parts: Array<['HOLD' | 'RELEASE' | 'DEBIT' | 'REFUND', bigint]>, when = at(0)) => {
    for (const [type, amount] of parts) {
      await prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor: amount, currency: 'AED', reference: `booking:${id}`, idempotencyKey: `${suffix}-${id}-${type}-${++seq}`, immutableAt: when } })
    }
  }
  const getRuns = async (who: string) => (await get('/ledger-integrity/runs', who).expect(200)).body.data

  beforeAll(async () => {
    await prisma.$connect()
    await provisionLedgerAuditRole(prisma as never, { loginRole: LOGIN, password: LOGIN_PASSWORD })
    for (const k of ['LEDGER_AUDIT_DATABASE_URL', 'LEDGER_INTEGRITY_SWEEP_ENABLED', 'LEDGER_INTEGRITY_CHECK_INTERVAL_MS']) savedEnv[k] = process.env[k]
    process.env.LEDGER_AUDIT_DATABASE_URL = loginUrl; process.env.LEDGER_INTEGRITY_SWEEP_ENABLED = 'true'; process.env.LEDGER_INTEGRITY_CHECK_INTERVAL_MS = '3600000'

    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    tenantC = (await prisma.tenant.create({ data: { name: `${suffix} C`, slug: `${suffix}-c` } })).id
    tenantD = (await prisma.tenant.create({ data: { name: `${suffix} D`, slug: `${suffix}-d` } })).id
    walletAed = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'AED', creditLimit: 1_000_000n } })).id
    walletEur = (await prisma.wallet.create({ data: { tenantId: tenantA, currency: 'EUR', creditLimit: 1_000n } })).id
    walletB = (await prisma.wallet.create({ data: { tenantId: tenantB, currency: 'AED', creditLimit: 0n } })).id
    await entry(tenantA, walletAed, 'CREDIT', 500_000n, 'AED', at(-1))
    await entry(tenantA, walletEur, 'DEBIT', -5_000n, 'EUR', at(0)) // overdrawn
    await chain(tenantA, walletAed, 'ok-confirmed', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n]])
    await chain(tenantA, walletAed, 'bad-refund', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n], ['REFUND', 1500n]])
    await entry(tenantB, walletB, 'CREDIT', 999_999n, 'AED', at(0))
    await chain(tenantB, walletB, 'b-ok', [['HOLD', -1000n], ['RELEASE', 1000n], ['DEBIT', -1000n]])
    // C: one old stored run, written by the owner as a fixture
    const old = new Date(NOW.getTime() - 3 * 86_400_000)
    await prisma.ledgerIntegrityRun.create({ data: { tenantId: tenantC, runDate: new Date(runDateUtc(old) + 'T00:00:00.000Z'), status: 'PASS', errors: 0, warnings: 0, accountsScanned: 0, bookingsScanned: 0, entriesScanned: 0, report: {} } })

    const a = await user('a', tenantA, ['finance.read']); const aNone = await user('anone', tenantA, [])
    const b = await user('b', tenantB, ['finance.read']); const c = await user('c', tenantC, ['finance.read']); const d = await user('d', tenantD, ['finance.read'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    runs = app.get(LedgerIntegrityRunsService); sweeper = app.get(LedgerIntegritySweeper)
    cookies.a = await login(a); cookies.anone = await login(aNone); cookies.b = await login(b); cookies.c = await login(c); cookies.d = await login(d)
  })

  afterAll(async () => {
    await app?.close()
    await restricted.$disconnect()
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    const all = [tenantA, tenantB, tenantC, tenantD].filter(Boolean)
    await prisma.auditEvent.deleteMany({ where: { tenantId: { in: all }, action: 'finance.integrity.run' } })
    for (const tenantId of all) {
      await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
      await prisma.wallet.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: all } } }) // stored runs go with the tenant (the cascade is the one allowed deletion)
    await deprovisionLedgerAuditRole(prisma as never, LOGIN, { dropGroup: true })
    await prisma.$disconnect()
  })

  it('NR-01 the restricted role verifies clean and is confined: it reads money but cannot change it, cannot read bookings or users, and cannot edit or delete stored runs', async () => {
    expect(await verifyLedgerAuditRole(restricted as never)).toEqual({ ok: true, failures: [] })
    const denied = async (sql: string) => { await expect(restricted.$queryRawUnsafe(sql)).rejects.toMatchObject({ meta: { code: '42501' } }) }
    await denied(`SELECT count(*) FROM "Booking"`)
    await denied(`SELECT count(*) FROM users`)
    await denied(`SELECT name FROM tenants LIMIT 1`)
    await denied(`UPDATE "LedgerEntry" SET amount_minor = 0 WHERE false`)
    await denied(`INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`)
    await denied(`DELETE FROM "Wallet" WHERE false`)
    await denied(`UPDATE "LedgerIntegrityRun" SET status = 'PASS' WHERE false`)
    await denied(`DELETE FROM "LedgerIntegrityRun" WHERE false`)
    await expect(restricted.$queryRawUnsafe(`SELECT current_user AS u`)).resolves.toEqual([{ u: LOGIN }])
    expect(await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT pg_has_role('${LOGIN}', '${LEDGER_AUDIT_GROUP_ROLE}', 'MEMBER') AS ok`)).toEqual([{ ok: true }])
  })

  it('NR-02 permission: anonymous 401; no finance.read 403; finance.read 200 (history and detail)', async () => {
    await get('/ledger-integrity/runs', 'anon').expect(401)
    await get('/ledger-integrity/runs', 'anone').expect(403)
    await get('/ledger-integrity/runs/someid', 'anone').expect(403)
    await get('/ledger-integrity/runs', 'a').expect(200)
  })

  it('NR-03 before any run: tenant D is NEVER_RUN with an empty history, and the scheduler is reported as enabled', async () => {
    const d = await getRuns('d')
    expect(d.schedule).toBe('NEVER_RUN')
    expect(d.runs).toEqual([]); expect(d.latest).toBeNull()
    expect(d.scheduler).toMatchObject({ enabled: true, runHourUtc: 1 })
  })

  it('NR-04 a stale history is OVERDUE: tenant C has only a run from three days ago', async () => {
    const c = await getRuns('c')
    expect(c.schedule).toBe('OVERDUE')
    expect(c.latest.status).toBe('PASS')
  })

  it('NR-05 recording a run stores the snapshot once, with the verdict and counts; repeating it changes nothing', async () => {
    expect(await runs.recordRun(tenantA, NOW)).toBe('recorded')
    expect(await runs.recordRun(tenantA, NOW)).toBe('exists')
    expect(await runs.recordRun(tenantA, new Date(NOW.getTime() + 3_600_000))).toBe('exists') // same UTC date
    const rows = await prisma.ledgerIntegrityRun.findMany({ where: { tenantId: tenantA } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'FAIL', trigger: 'SCHEDULED', truncated: false, accountsScanned: 2, bookingsScanned: 2 })
    expect(rows[0].errors).toBeGreaterThanOrEqual(2) // refund exceeds charge, EUR overdrawn
    expect(rows[0].runDate.toISOString().slice(0, 10)).toBe(TODAY)
  })

  it('NR-06 the run writes exactly one SYSTEM audit event: no user, tenant scoped, ids and counts only', async () => {
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, action: 'finance.integrity.run' } })
    expect(events).toHaveLength(1)
    const run = await prisma.ledgerIntegrityRun.findFirstOrThrow({ where: { tenantId: tenantA } })
    expect(events[0]).toMatchObject({ actorType: 'SYSTEM', userId: null, entityType: 'ledger_integrity_run', entityId: run.id })
    expect(events[0].payload).toMatchObject({ runDate: TODAY, status: 'FAIL', errors: run.errors, warnings: run.warnings, truncated: false })
  })

  it('NR-07 history over HTTP: tenant A is on schedule, newest first, with the stored verdict', async () => {
    const a = await getRuns('a')
    expect(a.schedule).toBe('OK')
    expect(a.runs).toHaveLength(1)
    expect(a.latest).toMatchObject({ runDate: TODAY, status: 'FAIL', truncated: false })
    expect(a.latest.errors).toBeGreaterThanOrEqual(2)
  })

  it('NR-08 the stored report is exactly what was found: same findings as the live report, with amounts as integer strings', async () => {
    const a = await getRuns('a')
    const stored = (await get(`/ledger-integrity/runs/${a.latest.id}`, 'a').expect(200)).body.data
    const live = (await get('/ledger-integrity', 'a').expect(200)).body.data
    expect(stored.run.id).toBe(a.latest.id)
    expect(stored.report.status).toBe('FAIL')
    type F = { code: string; bookingId: string | null; accountId: string | null }
    const key = (f: F) => `${f.code}:${f.bookingId ?? f.accountId ?? ''}`
    expect(stored.report.findings.map(key).sort()).toEqual(live.findings.map(key).sort())
    expect(stored.report.findings.find((f: { bookingId: string }) => f.bookingId === 'bad-refund').amountsMinor).toEqual({ heldMinor: '1000', releasedMinor: '1000', chargedMinor: '1000', refundedMinor: '1500' })
    expect(stored.report.control.map((c: { currency: string }) => c.currency)).toEqual(['AED', 'EUR'])
  })

  it('NR-09 a clean tenant stores PASS; tenants never see each other\'s runs or reports', async () => {
    expect(await runs.recordRun(tenantB, NOW)).toBe('recorded')
    const b = await getRuns('b')
    expect(b.latest).toMatchObject({ status: 'PASS', errors: 0, warnings: 0 })
    expect(b.runs).toHaveLength(1)
    const a = await getRuns('a')
    expect(a.runs.map((r: { id: string }) => r.id)).not.toContain(b.latest.id)
    await get(`/ledger-integrity/runs/${a.latest.id}`, 'b').expect(404) // tenant B asking for tenant A's run
    await get(`/ledger-integrity/runs/${b.latest.id}`, 'a').expect(404)
    await get('/ledger-integrity/runs/not-an-id!', 'a').expect(400)
  })

  it('NR-10 stored runs cannot be edited or deleted, even by the database owner; a verdict that contradicts its counts is refused', async () => {
    const run = await prisma.ledgerIntegrityRun.findFirstOrThrow({ where: { tenantId: tenantA } })
    await expect(prisma.ledgerIntegrityRun.update({ where: { id: run.id }, data: { status: 'PASS' } })).rejects.toThrow(/append-only/)
    await expect(prisma.ledgerIntegrityRun.delete({ where: { id: run.id } })).rejects.toThrow(/append-only/)
    await expect(prisma.ledgerIntegrityRun.create({ data: { tenantId: tenantD, runDate: new Date('2020-01-01T00:00:00Z'), status: 'PASS', errors: 3, warnings: 0, accountsScanned: 0, bookingsScanned: 0, entriesScanned: 0, report: {} } })).rejects.toThrow()
    expect(await prisma.ledgerIntegrityRun.count({ where: { tenantId: tenantA } })).toBe(1)
  })

  it('NR-11 the database itself allows the run\'s one audit event and refuses any other, any user-type one, and any for another tenant', async () => {
    // Row-level security, as the restricted role. The positive control proves the method works, so each refusal below is the rule and not a typo.
    const insert = (id: string, tenantId: string, actor: string, action: string, entity: string) =>
      `INSERT INTO "AuditEvent" ("id","tenant_id","actor_type","action","entity_type","entity_id","payload") VALUES ('${id}','${tenantId}','${actor}','${action}','${entity}','x','{}')`
    const inTenant = (tenantId: string, sql: string) => restricted.$transaction(async t => {
      await t.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantId}', true)`)
      await t.$executeRawUnsafe(sql)
      throw new Error('rollback') // never keep these rows
    })
    const allowed = insert(`${suffix}-ok`, tenantA, 'SYSTEM', 'finance.integrity.run', 'ledger_integrity_run')
    await expect(inTenant(tenantA, allowed)).rejects.toThrow('rollback')                                  // reached the end: the insert itself succeeded
    await expect(inTenant(tenantA, insert(`${suffix}-1`, tenantA, 'SYSTEM', 'booking.cancelled', 'booking'))).rejects.toThrow(/row-level security|42501/)
    await expect(inTenant(tenantA, insert(`${suffix}-2`, tenantA, 'USER', 'finance.integrity.run', 'ledger_integrity_run'))).rejects.toThrow(/row-level security|42501/)
    await expect(inTenant(tenantA, insert(`${suffix}-3`, tenantB, 'SYSTEM', 'finance.integrity.run', 'ledger_integrity_run'))).rejects.toThrow(/row-level security|42501/) // another tenant's id
    // And a stored run for another tenant is refused the same way.
    const run = (tenantId: string) => `INSERT INTO "LedgerIntegrityRun" ("id","tenant_id","run_date","status","errors","warnings","accounts_scanned","bookings_scanned","entries_scanned","report") VALUES ('${suffix}-r','${tenantId}','2020-02-02','PASS',0,0,0,0,0,'{}')`
    await expect(inTenant(tenantA, run(tenantA))).rejects.toThrow('rollback')
    await expect(inTenant(tenantA, run(tenantB))).rejects.toThrow(/row-level security|42501/)
    expect(await prisma.auditEvent.count({ where: { id: { startsWith: suffix } } })).toBe(0)
    expect(await prisma.ledgerIntegrityRun.count({ where: { id: `${suffix}-r` } })).toBe(0)
  })

  it('NR-12 the scheduler records the remaining tenant, covers a night once, and a second pass does nothing', async () => {
    const before = await prisma.ledgerIntegrityRun.count({ where: { tenantId: tenantD } })
    expect(before).toBe(0)
    expect(await sweeper.runOnce(NOW)).toBeGreaterThanOrEqual(1) // D, C (today has none) and any other active tenant in the shared test database
    const d = await getRuns('d')
    expect(d.schedule).toBe('OK')
    expect(d.latest).toMatchObject({ status: 'PASS', runDate: TODAY })
    expect(await prisma.ledgerIntegrityRun.count({ where: { tenantId: tenantA } })).toBe(1) // A and B were already covered
    expect(await sweeper.runOnce(NOW)).toBe(0)
    const c = await getRuns('c')
    expect(c.runs).toHaveLength(2) // the old fixture and tonight's
    expect(c.schedule).toBe('OK')
  })

  it('NR-13 the live report is served through the restricted credential too (the web role has no ledger access on a strict deployment)', async () => {
    const live = (await get('/ledger-integrity', 'a').expect(200)).body.data
    expect(live.status).toBe('FAIL')
    expect(live.scanned).toMatchObject({ accounts: 2, bookings: 2 })
  })
})
