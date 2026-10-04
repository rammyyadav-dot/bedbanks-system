#!/usr/bin/env node
/**
 * Runtime boot certification of the strict API database role (ADR 0032).
 *
 * Boots the REAL API entry point (the same command as `pnpm start`) with DATABASE_URL set to the provisioned non-superuser, non-BYPASSRLS
 * login role, then exercises it over HTTP: tenant context, agency state, distribution restrictions, markup rules, a permitted Admin
 * mutation, a prohibited one, and tenant isolation. The owner connection is used only to provision the role and seed disposable fixtures
 * and is never given to the API process.
 *
 *   OWNER_DATABASE_URL=postgresql://...@localhost:PORT/p05_main REDIS_URL=redis://127.0.0.1:6390 node scripts/strict-role-boot-smoke.cjs
 *
 * Refuses anything but a local, disposable database. Prints check names and results only: no URL, password or token.
 */
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const path = require('node:path')
const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

const ownerUrl = process.env.OWNER_DATABASE_URL
if (!ownerUrl) { console.error('OWNER_DATABASE_URL (a disposable local owner connection) is required'); process.exit(2) }
const parsed = new URL(ownerUrl)
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/^(fbeds_ci|p0\d_[a-z0-9_]+)$/.test(parsed.pathname.slice(1))) { console.error('Refusing: not a local disposable database'); process.exit(2) }

const PORT = Number(process.env.SMOKE_PORT ?? 3917)
const ORIGIN = 'http://localhost:3001'
const base = `http://127.0.0.1:${PORT}/api/v1`
const suffix = `boot-${Date.now()}-${randomBytes(3).toString('hex')}`
const loginPassword = `Pw-${randomBytes(12).toString('hex')}`
const runtimePassword = randomBytes(24).toString('hex')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`) }
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function http(method, route, cookie, body) {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const json = await response.json().catch(() => ({}))
  return { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  await owner.$connect()
  // The provisioning code is TypeScript; load it through the same SWC register the API uses.
  require('@swc-node/register')
  const { provisionApiRuntimeRole, verifyApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } = require(path.join(__dirname, '..', 'src', 'database', 'api-runtime-role.ts'))
  await provisionApiRuntimeRole(owner, { password: runtimePassword })
  const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = API_RUNTIME_LOGIN_ROLE; runtimeUrl.password = runtimePassword
  const probe = new PrismaClient({ datasourceUrl: runtimeUrl.toString() })
  check('role verifier passes as the login role', (await verifyApiRuntimeRole(probe)).ok)
  await probe.$disconnect()

  // ---- disposable fixtures (owner) ------------------------------------------------------------------------------------------------------
  const tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
  const tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
  const hash = await bcrypt.hash(loginPassword, 12)
  const userIds = []
  const mkUser = async (label, tenantId, keys) => {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const role = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: role.id } })
    return { id: u.id, email }
  }
  const ADMIN = ['supply.hotels.read', 'supply.hotels.manage', 'supply.rates.read', 'supply.rates.manage', 'agency.read', 'agency.manage', 'distribution.read', 'distribution.manage']
  const admin = await mkUser('admin', tenantA, ADMIN)
  const agent = await mkUser('agent', tenantA, ['hotel.search'])
  const badmin = await mkUser('badmin', tenantB, ADMIN)
  const supplier = await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })
  const board = await owner.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })
  const hotel = await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
  const room = await owner.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: suffix, maxAdults: 2, maxOccupancy: 2 } })
  const mapping = await owner.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId: supplier.id, hotelId: hotel.id, supplierHotelId: `${suffix}-h`, status: 'MAPPED' } })
  await owner.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-r`, roomTypeId: room.id, status: 'MAPPED' } })
  const contract = await owner.contract.create({ data: { tenantId: tenantA, supplierId: supplier.id, supplierHotelMappingId: mapping.id, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
  const plan = await owner.ratePlan.create({ data: { tenantId: tenantA, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: 'P', status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
  const nights = [day(20), day(21)].map((d) => new Date(d))
  await owner.dailyRate.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'NET' })) })
  await owner.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: plan.id, stayDate, allotment: 5 })) })
  await owner.commercialMarkupRule.create({ data: { tenantId: tenantA, scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: new Date(day(-30)), status: 'ACTIVE', activatedAt: new Date(), reason: 'Standard margin', createdById: admin.id } })
  const agency = await owner.agency.create({ data: { tenantId: tenantA, code: `AG-${suffix.slice(-6).toUpperCase()}`, name: 'Boot agency', createdById: admin.id } })
  await owner.agencyMember.create({ data: { tenantId: tenantA, agencyId: agency.id, userId: agent.id } })

  // ---- boot the real API on the strict role ------------------------------------------------------------------------------------------------
  const env = { ...process.env, DATABASE_URL: runtimeUrl.toString(), MAPPING_DATABASE_URL: runtimeUrl.toString(), API_PORT: String(PORT), API_HOST: '127.0.0.1', ADMIN_ORIGIN: ORIGIN, NODE_ENV: 'development' }
  delete env.OWNER_DATABASE_URL
  const child = spawn('node', ['--no-experimental-strip-types', '-r', '@swc-node/register', 'src/main.ts'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d }); child.stderr.on('data', (d) => { output += d })
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500))
    up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)
  }
  check('API boots on the strict role (normal start path) and answers /health', up, output.split('\n').filter((l) => l.trim() && !/postgres(ql)?:\/\//.test(l)).slice(-6).join(' | ').replace(/\u001b\[[0-9;]*m/g, ''))
  try {
    if (!up) throw new Error('API did not start')
    const [{ n }] = await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = '${API_RUNTIME_LOGIN_ROLE}' AND datname = current_database()`)
    check('the API process holds connections as the strict login role', n > 0)

    const login = async (email) => (await http('POST', '/auth/login', null, { email, password: loginPassword })).cookie
    const adminCookie = await login(admin.email); const agentCookie = await login(agent.email); const bCookie = await login(badmin.email)
    check('authenticated sessions resolve (tenant context from the session, not the request)', Boolean(adminCookie && agentCookie && bCookie))

    const searchBody = { destination: 'Dubai', checkIn: day(20), checkOut: day(22), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 }
    const search = await http('POST', '/agent/search', agentCookie, searchBody)
    const rates = (search.json.data?.hotels ?? []).flatMap((h) => h.rooms.flatMap((r) => r.rates))
    check('agency state loads (suspension guard) and the search runs', search.status === 201 && search.json.data?.status === 'available')
    check('distribution restrictions load and markup rules load (NET rate priced with 10 percent markup)', rates.length === 1 && rates[0].sellAmountMinor === 110_000)

    const created = await http('POST', '/admin/clients/agencies', adminCookie, { code: `BT-${randomBytes(3).toString('hex').toUpperCase()}`, name: 'Created on the strict role', countryCode: 'AE' })
    check('permitted Admin mutation succeeds (agency create)', created.status === 201)
    const denied = await http('POST', '/supply/board-bases', adminCookie, { code: 'ZZ', name: 'Prohibited path' })
    check('prohibited Admin mutation is a typed 403 with no database text', denied.status === 403 && denied.json.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && !/permission denied|42501|BoardBasis/.test(JSON.stringify(denied.json)))
    check('no row was written by the prohibited mutation', (await owner.boardBasis.count({ where: { tenantId: tenantA, code: 'ZZ' } })) === 0)
    const noPerm = await http('POST', '/admin/clients/agencies', agentCookie, { code: 'NP-1', name: 'No permission', countryCode: 'AE' })
    check('an authenticated user without the permission gets 403 FORBIDDEN', noPerm.status === 403 && noPerm.json.error?.code === 'FORBIDDEN')
    const anon = await http('POST', '/admin/clients/agencies', null, { code: 'AN-1', name: 'Anon', countryCode: 'AE' })
    check('unauthenticated gets 401', anon.status === 401)
    const cross = await http('PATCH', `/admin/clients/agencies/${agency.id}`, bCookie, { name: 'Hijack' })
    check('tenant isolation: another tenant cannot reach the agency (404) and the row is unchanged', cross.status === 404 && (await owner.agency.findUniqueOrThrow({ where: { id: agency.id } })).name === 'Boot agency')
    const listB = await http('GET', '/admin/clients/agencies', bCookie)
    check('tenant isolation: another tenant lists none of this tenant\'s agencies', listB.status === 200 && JSON.stringify(listB.json).indexOf('Boot agency') < 0)
    const audit = await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'runtime_role.operation_prohibited' } })
    check('the prohibited attempt left an audit event', audit === 1)
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))
    for (const q of [
      `DELETE FROM "AuditEvent" WHERE tenant_id IN ('${tenantA}','${tenantB}')`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Agency" WHERE tenant_id IN ('${tenantA}','${tenantB}')`, `DELETE FROM "CommercialMarkupRule" WHERE tenant_id = '${tenantA}'`,
      `DELETE FROM "DailyAvailability" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "DailyRate" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "RatePlan" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Contract" WHERE tenant_id = '${tenantA}'`,
      `DELETE FROM "SupplierRoomMapping" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "SupplierHotelMapping" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "RoomType" WHERE hotel_id IN (SELECT id FROM "Hotel" WHERE tenant_id = '${tenantA}')`, `DELETE FROM "Hotel" WHERE tenant_id = '${tenantA}'`,
      `DELETE FROM "BoardBasis" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Supplier" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "UserRole" WHERE tenant_id IN ('${tenantA}','${tenantB}')`,
      `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id IN ('${tenantA}','${tenantB}'))`, `DELETE FROM "Role" WHERE tenant_id IN ('${tenantA}','${tenantB}')`, `DELETE FROM memberships WHERE tenant_id IN ('${tenantA}','${tenantB}')`,
    ]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined)
    await owner.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined)
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }).catch(() => undefined)
    await owner.$disconnect()
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}).catch((error) => { console.error(`FAIL  smoke aborted: ${String(error.message ?? error).split('\n')[0]}`); process.exit(1) })
