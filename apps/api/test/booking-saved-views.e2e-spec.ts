import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingSavedViewList, BookingSavedViewView } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(180_000)

/** Personal saved views over HTTP (ADR 0039, Phase 6B): strict API role (no booking grants) + the booking role (own rows only, by RLS and by owner scope). */
describe('Booking saved views (PostgreSQL, HTTP, strict roles)', () => {
  const owner = new PrismaClient()
  const suffix = `sv-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'saved-views-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', tenantB = ''
  const cookies: Record<string, string> = {}; const userIds: Record<string, string> = {}; const all: string[] = []
  const VIEW = ['booking.read', 'booking.savedview.read', 'booking.savedview.create', 'booking.savedview.update.own', 'booking.savedview.delete.own']

  async function user(label: string, tenantId: string, keys: string[]) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(u.id); userIds[label] = u.id
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
  }
  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, who: string, body?: unknown) => {
    const r = request(app.getHttpServer())[method](`/api/v1/admin/operations/booking-views${path}`).set('Cookie', cookies[who])
    return method === 'get' ? r : r.set('Origin', origin).send((body ?? {}) as object)
  }
  const code = (res: request.Response) => res.body.error?.code ?? res.body.code ?? res.body.message?.code
  const create = async (who: string, name: string, extra: Record<string, unknown> = {}) => (await call('post', '', who, { name, filters: { status: 'FAILED' }, ...extra }).expect(201)).body.data as { id: string; version: number }
  const list = async (who: string): Promise<BookingSavedViewList> => (await call('get', '', who).expect(200)).body.data
  const one = async (who: string, id: string): Promise<BookingSavedViewView> => (await call('get', `/${id}`, who).expect(200)).body.data

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    await user('ann', tenantA, VIEW)
    await user('bob', tenantA, VIEW)
    await user('boss', tenantA, [...VIEW, 'booking.pii.view', 'booking.finance.view', 'booking.ops.view', 'booking.view.agency'])
    await user('reader', tenantA, ['booking.read', 'booking.savedview.read'])
    await user('nobody', tenantA, ['booking.read'])
    await user('carl', tenantB, VIEW)
    restoreOps = await enableBookingOps(owner)
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['ann', 'bob', 'boss', 'reader', 'nobody', 'carl']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "BookingSavedView" WHERE tenant_id = '${t}'`, `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: all } } }); await owner.user.deleteMany({ where: { id: { in: all } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('SV-E01: create, read, rename and update a view; opening it returns the canonical URL parameters; an update needs the current version', async () => {
    const v = await create('ann', ' Failed   today ', { description: 'Check these first', sort: { sort: 'amount', dir: 'asc' }, visibleColumns: ['hotel', 'status'], filters: { status: 'FAILED,CONFIRMED', dateType: 'checkIn', from: '2030-01-01' } })
    const got = await one('ann', v.id)
    expect(got).toMatchObject({ name: 'Failed today', description: 'Check these first', isDefault: false, version: 1, sort: { sort: 'amount', dir: 'asc' }, visibleColumns: ['reference', 'hotel', 'status', 'actions'] })
    expect(got.filters).toEqual({ dateType: 'checkIn', from: '2030-01-01', status: 'CONFIRMED,FAILED' })
    expect(got.resolution).toEqual({ status: 'ok', params: { dateType: 'checkIn', from: '2030-01-01', status: 'CONFIRMED,FAILED', sort: 'amount', dir: 'asc' } })
    const renamed = (await call('patch', `/${v.id}`, 'ann', { expectedVersion: 1, name: 'Failed this week' }).expect(200)).body.data
    expect(renamed.version).toBe(2)
    expect(code(await call('patch', `/${v.id}`, 'ann', { expectedVersion: 1, name: 'Stale write' }))).toBe('SAVED_VIEW_STALE')
    const updated = (await call('patch', `/${v.id}`, 'ann', { expectedVersion: 2, filters: { status: 'REJECTED' }, sort: { sort: 'checkIn', dir: 'desc' } }).expect(200)).body.data
    const after = await one('ann', v.id)
    expect(updated.version).toBe(3); expect(after).toMatchObject({ name: 'Failed this week', filters: { status: 'REJECTED' }, sort: { sort: 'checkIn', dir: 'desc' } })
    expect((await call('patch', `/${v.id}`, 'ann', { name: 'no version' })).status).toBe(400)
  })

  it('SV-E02: a name is unique per person, ignoring case; two people may share one; the per-person limit holds', async () => {
    await create('bob', 'Mine'); expect(code(await call('post', '', 'bob', { name: 'MINE', filters: {} }))).toBe('SAVED_VIEW_NAME_TAKEN')
    await create('ann', 'Mine')
    const v = await create('bob', 'Other'); expect(code(await call('patch', `/${v.id}`, 'bob', { expectedVersion: 1, name: 'mine' }))).toBe('SAVED_VIEW_NAME_TAKEN')
    const have = (await list('bob')).items.length
    for (let i = have; i < 50; i++) await owner.bookingSavedView.create({ data: { tenantId: tenantA, ownerUserId: userIds.bob, name: `filler ${i}`, nameKey: `filler ${i}`, filtersJson: {}, sortJson: { sort: 'created', dir: 'desc' }, updatedAt: new Date() } })
    expect(code(await call('post', '', 'bob', { name: 'one too many', filters: {} }))).toBe('SAVED_VIEW_LIMIT')
  })

  it('SV-E03: views are private: another person (even a boss with every permission) cannot read, change, default or delete them; the answer is 404, never 403', async () => {
    const v = await create('ann', 'Private one')
    for (const who of ['bob', 'boss', 'carl']) {
      expect((await call('get', `/${v.id}`, who)).status).toBe(404)
      expect(code(await call('patch', `/${v.id}`, who, { expectedVersion: 1, name: 'hijack' }))).toBe('SAVED_VIEW_NOT_FOUND')
      expect((await call('post', `/${v.id}/default`, who)).status).toBe(404)
      expect((await call('delete', `/${v.id}`, who)).status).toBe(404)
      expect((await list(who)).items.some((i) => i.id === v.id)).toBe(false)
    }
    expect(await one('ann', v.id)).toMatchObject({ name: 'Private one', version: 1, isDefault: false })
    // Ownership cannot be named or transferred through the body.
    for (const body of [{ ownerUserId: userIds.bob }, { tenantId: tenantB }, { userId: userIds.bob }]) expect((await call('post', '', 'ann', { name: 'x', filters: {}, ...body })).status).toBe(400)
    expect((await call('patch', `/${v.id}`, 'ann', { expectedVersion: 1, ownerUserId: userIds.bob })).status).toBe(400)
  })

  it('SV-E04: one default per person; setting another moves it; clearing resets to the system default; defaults are per person', async () => {
    const a = await create('ann', 'D1'); const b = await create('ann', 'D2'); const other = await create('boss', 'Boss default')
    await call('post', `/${a.id}/default`, 'ann').expect(200)
    await call('post', `/${other.id}/default`, 'boss').expect(200)
    expect((await list('ann')).items.filter((i) => i.isDefault).map((i) => i.id)).toEqual([a.id])
    await call('post', `/${b.id}/default`, 'ann').expect(200)
    expect((await list('ann')).items.filter((i) => i.isDefault).map((i) => i.id)).toEqual([b.id])
    expect((await list('ann')).items[0].id).toBe(b.id) // the default leads the list
    expect((await list('boss')).items.filter((i) => i.isDefault).map((i) => i.id)).toEqual([other.id]) // untouched
    expect((await call('post', '/default/clear', 'ann').expect(200)).body.data.cleared).toBe(1)
    expect((await list('ann')).items.some((i) => i.isDefault)).toBe(false)
    expect((await call('post', '/default/clear', 'ann').expect(200)).body.data.cleared).toBe(0) // idempotent
    // The database itself allows only one default per person per tenant.
    await call('post', `/${a.id}/default`, 'ann').expect(200)
    await expect(owner.bookingSavedView.update({ where: { id: b.id }, data: { defaultSlot: 1 } })).rejects.toThrow()
  })

  it('SV-E05: delete removes only the caller\'s view, and is audited with ids only (never the filters)', async () => {
    const v = await create('ann', 'Delete me', { filters: { reference: 'SECRET-REF-123' } })
    await call('delete', `/${v.id}`, 'ann').expect(200)
    expect((await call('get', `/${v.id}`, 'ann')).status).toBe(404)
    expect((await call('delete', `/${v.id}`, 'ann')).status).toBe(404)
    const audits = await owner.auditEvent.findMany({ where: { entityId: v.id }, orderBy: { createdAt: 'asc' } })
    expect(audits.map((a) => a.action)).toEqual(['booking.savedview.created', 'booking.savedview.deleted'])
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toMatch(/SECRET-REF|Delete me/)
    expect(audits.every((a) => a.userId === userIds.ann && a.actorType === 'USER')).toBe(true)
  })

  it('SV-E06: permissions: each route needs its own; a reader cannot write; someone without any view permission is refused; the tenant comes from the session', async () => {
    expect((await call('get', '', 'nobody')).status).toBe(403)
    expect((await call('post', '', 'reader', { name: 'x', filters: {} })).status).toBe(403)
    const v = await create('ann', 'Perm test')
    await owner.$executeRawUnsafe(`UPDATE "BookingSavedView" SET name = name WHERE id = '${v.id}'`) // owner can; the checks below are about the HTTP roles
    expect((await call('get', '', 'reader')).status).toBe(200)
    expect((await call('patch', `/${v.id}`, 'reader', { expectedVersion: 1, name: 'z' })).status).toBe(403)
    expect((await call('delete', `/${v.id}`, 'reader')).status).toBe(403)
    expect((await call('post', `/${v.id}/default`, 'reader')).status).toBe(403)
    expect((await call('post', '/default/clear', 'reader')).status).toBe(403)
    expect((await list('carl')).items.map((i) => i.name)).toEqual([]) // another tenant sees none of tenant A's views
    const unauth = await request(app.getHttpServer()).get('/api/v1/admin/operations/booking-views'); expect([401, 403]).toContain(unauth.status)
  })

  it('SV-E07: a stored view is re-validated on every open: an old grammar is stale, a filter the caller lost is restricted, and neither is applied', async () => {
    const stale = await owner.bookingSavedView.create({ data: { tenantId: tenantA, ownerUserId: userIds.ann, name: 'Old grammar', nameKey: 'old grammar', filtersJson: { status: 'NO_LONGER_A_STATUS' }, sortJson: { sort: 'created', dir: 'desc' }, updatedAt: new Date() } })
    const smuggled = await owner.bookingSavedView.create({ data: { tenantId: tenantA, ownerUserId: userIds.ann, name: 'Smuggled', nameKey: 'smuggled', filtersJson: { hotel: 'atlantis', moneyEvent: 'CANCELLED' }, sortJson: { sort: 'created', dir: 'desc' }, updatedAt: new Date() } })
    expect((await one('ann', stale.id)).resolution).toMatchObject({ status: 'stale' })
    expect((await one('ann', smuggled.id)).resolution).toMatchObject({ status: 'restricted' }) // ann lacks booking.finance.view
    // The same row under a caller who holds the permission would run; here it belongs to ann, so only her access counts.
    const boss = await owner.bookingSavedView.create({ data: { tenantId: tenantA, ownerUserId: userIds.boss, name: 'Boss', nameKey: 'boss', filtersJson: { moneyEvent: 'CANCELLED' }, sortJson: { sort: 'created', dir: 'desc' }, updatedAt: new Date() } })
    expect((await one('boss', boss.id)).resolution).toMatchObject({ status: 'ok' })
    // Saving a view that uses a filter the caller cannot use is refused outright.
    expect(code(await call('post', '', 'ann', { name: 'Cannot save', filters: { moneyEvent: 'CANCELLED' } }))).toBe('SAVED_VIEW_FORBIDDEN')
    expect(code(await call('post', '', 'ann', { name: 'Cannot save 2', filters: { guest: 'Haddad' } }))).toBe('SAVED_VIEW_FORBIDDEN')
    // A stale view can still be renamed and deleted.
    await call('patch', `/${stale.id}`, 'ann', { expectedVersion: 1, name: 'Old grammar (fix me)' }).expect(200)
    await call('delete', `/${stale.id}`, 'ann').expect(200)
  })

  it('SV-E08: the booking role can only touch its own rows; keys cannot be rewritten; the API role cannot read the table; row-level security isolates tenants', async () => {
    const v = await create('ann', 'Grants')
    const role = new PrismaClient({ datasourceUrl: process.env.BOOKING_OPS_DATABASE_URL as string })
    try {
      const run = (q: string) => role.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantA}', true)`); return tx.$executeRawUnsafe(q) })
      for (const q of [`UPDATE "BookingSavedView" SET tenant_id = '${tenantB}'`, `UPDATE "BookingSavedView" SET owner_user_id = '${userIds.bob}'`, `UPDATE "BookingSavedView" SET created_at = now()`, `TRUNCATE "BookingSavedView"`]) await expect(run(q)).rejects.toThrow(/permission denied/)
      expect(await role.bookingSavedView.count()).toBe(0) // no tenant context: nothing is visible
      await expect(role.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantB}', true)`); return tx.$executeRawUnsafe(`INSERT INTO "BookingSavedView" (id, tenant_id, owner_user_id, name, name_key, filters_json, sort_json, updated_at) VALUES ('x', '${tenantA}', '${userIds.ann}', 'n', 'n', '{}', '{}', now())`) })).rejects.toThrow()
      for (const q of [`DELETE FROM "BookingEvent"`, `DELETE FROM "Booking"`]) await expect(run(q)).rejects.toThrow(/permission denied/) // the one DELETE grant is saved views only
    } finally { await role.$disconnect() }
    const api = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL as string })
    try { await expect(api.$queryRawUnsafe('SELECT 1 FROM "BookingSavedView" LIMIT 1')).rejects.toThrow(/permission denied/) } finally { await api.$disconnect() }
    expect(await one('ann', v.id)).toMatchObject({ name: 'Grants' })
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingSavedView" SET filters_json = '{"tenantId":"x"}' WHERE id = '${v.id}'`)).rejects.toThrow(/check/i) // a tenant id cannot even be stored
  })

  it('SV-E09: removing a membership removes that person\'s views (no orphan can name a user outside the tenant)', async () => {
    await user('temp', tenantA, VIEW); const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-temp@example.test`, password }).expect(200); cookies.temp = (r.headers['set-cookie'][0] as string).split(';')[0]
    await create('temp', 'Will vanish')
    await owner.membership.delete({ where: { userId_tenantId: { userId: userIds.temp, tenantId: tenantA } } })
    expect(await owner.bookingSavedView.count({ where: { ownerUserId: userIds.temp } })).toBe(0)
  })
})
