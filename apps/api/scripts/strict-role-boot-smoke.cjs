#!/usr/bin/env node
/**
 * Runtime boot certification of the strict API database role (ADR 0032).
 *
 * Boots the REAL API entry point (the same command as `pnpm start`) with DATABASE_URL set to the provisioned non-superuser, non-BYPASSRLS
 * login role, then exercises it over HTTP: tenant context, agency state, distribution restrictions, markup rules, a permitted Admin
 * mutation, a prohibited one, and tenant isolation. It then covers the rate plan lifecycle (ADR 0041) in three boots: (A) the ordinary
 * restricted role alone, where activate, suspend and clone must fail closed; (B) with the narrow lifecycle role provisioned and configured,
 * where activate and suspend work, authorization, tenant isolation, readiness and versioning still apply, and clone stays refused; (C) with
 * an unusable lifecycle credential, where the result is a sanitized 503 and never a fallback write. The owner connection is used only to provision the role and seed disposable fixtures
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
  const { provisionRatePlanOpsRole, deprovisionRatePlanOpsRole, RATE_PLAN_OPS_LOGIN_ROLE } = require(path.join(__dirname, '..', 'src', 'database', 'rate-plan-ops-role.ts'))
  const { certifyRatePlanOpsRole } = require(path.join(__dirname, '..', 'src', 'database', 'rate-plan-ops-verify.ts'))
  const { provisionRatePlanCloneRole, deprovisionRatePlanCloneRole, RATE_PLAN_CLONE_LOGIN_ROLE } = require(path.join(__dirname, '..', 'src', 'database', 'rate-plan-clone-role.ts'))
  const { certifyRatePlanCloneRole } = require(path.join(__dirname, '..', 'src', 'database', 'rate-plan-clone-verify.ts'))
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
  const admin2 = await mkUser('admin2', tenantA, ADMIN)
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

  // ---- fixtures for the rate plan lifecycle (ADR 0041) ------------------------------------------------------------------------------------
  // `plan` (above) is ACTIVE with rates. P2 is a DRAFT that passes every readiness check; P3 is a DRAFT with no rates (must stay DRAFT).
  // Non-refundable so that no cancellation policy is needed for readiness.
  const mkDraft = async (code, withRates) => {
    const p = await owner.ratePlan.create({ data: { tenantId: tenantA, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code, status: 'DRAFT', refundable: false, occupancy: 2, currency: 'AED' } })
    if (withRates) {
      await owner.dailyRate.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: 60_000n, currency: 'AED', amountBasis: 'NET' })) })
      await owner.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: p.id, stayDate, allotment: 5 })) })
    }
    return p
  }
  const draftReady = await mkDraft('P2', true)
  const draftNoRates = await mkDraft('P3', false)
  const draftApproval = await mkDraft('P4', true)

  // ---- boot the real API on the strict role ------------------------------------------------------------------------------------------------
  let current = null
  const boot = async (label, extraEnv = {}) => {
    const env = { ...process.env, DATABASE_URL: runtimeUrl.toString(), MAPPING_DATABASE_URL: runtimeUrl.toString(), API_PORT: String(PORT), API_HOST: '127.0.0.1', ADMIN_ORIGIN: ORIGIN, NODE_ENV: 'development' }
    delete env.OWNER_DATABASE_URL; delete env.RATE_PLAN_OPS_DATABASE_URL; delete env.RATE_PLAN_CLONE_DATABASE_URL
    // Phases A to C exercise the single-actor lifecycle (ADR 0041), so approval is off for them; phase D proves the four-eye flow (ADR 0057, S5).
    env.RATE_PLAN_ACTIVATION_APPROVAL = 'off'
    Object.assign(env, extraEnv)
    const child = spawn('node', ['--no-experimental-strip-types', '-r', '@swc-node/register', 'src/main.ts'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => { output += d }); child.stderr.on('data', (d) => { output += d })
    current = child
    let up = false
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)
    }
    check(`${label}: API boots on the strict role (normal start path) and answers /health`, up, output.split('\n').filter((l) => l.trim() && !/postgres(ql)?:\/\//.test(l)).slice(-6).join(' | ').replace(/\u001b\[[0-9;]*m/g, ''))
    if (!up) throw new Error('API did not start')
  }
  const stop = async () => {
    if (!current) return
    const child = current; current = null
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))
  }
  const login = async (email) => (await http('POST', '/auth/login', null, { email, password: loginPassword })).cookie
  const planState = (id) => owner.ratePlan.findUniqueOrThrow({ where: { id }, select: { status: true, updatedAt: true } })
  const statusEvents = (id) => owner.auditEvent.count({ where: { tenantId: tenantA, action: 'supply.rate_plan.status_changed', entityId: id } })
  const version = async (cookie, id) => (await http('GET', `/supply/rate-plans/${id}/readiness`, cookie)).json.data?.updatedAt
  const safe = (res) => !/permission denied|42501|postgres(ql)?:\/\/|password|fbeds_rateplan_ops|RatePlan"/i.test(JSON.stringify(res.json))
  const searchBody = { destination: 'Dubai', checkIn: day(20), checkOut: day(22), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 }
  try {
    // ======== Phase A: ordinary restricted API role, no lifecycle role configured -------------------------------------------------------------
    await boot('A (no lifecycle role)')
    const [{ n }] = await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = '${API_RUNTIME_LOGIN_ROLE}' AND datname = current_database()`)
    check('the API process holds connections as the strict login role', n > 0)

    const adminCookie = await login(admin.email); const agentCookie = await login(agent.email); const bCookie = await login(badmin.email)
    check('authenticated sessions resolve (tenant context from the session, not the request)', Boolean(adminCookie && agentCookie && bCookie))

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

    // ---- rate plan lifecycle fails closed on the ordinary restricted role (ADR 0041, issue 304) ------------------------------------------
    const [rt] = await owner.$queryRawUnsafe(`SELECT has_column_privilege('${API_RUNTIME_LOGIN_ROLE}', '"RatePlan"', 'status', 'UPDATE') AS upd, has_table_privilege('${API_RUNTIME_LOGIN_ROLE}', '"RatePlan"', 'INSERT') AS ins, has_table_privilege('${API_RUNTIME_LOGIN_ROLE}', '"RatePlan"', 'DELETE') AS del`)
    check('the strict API login has no UPDATE on RatePlan.status, no INSERT and no DELETE on RatePlan', rt.upd === false && rt.ins === false && rt.del === false)
    const v2 = await version(adminCookie, draftReady.id)
    check('readiness reads work on the strict role', Boolean(v2))
    const capA = await http('GET', '/supply/rate-plans/capabilities', adminCookie)
    check('capabilities (no lifecycle role): activate, suspend and clone are unavailable, each with a reason', capA.status === 200 && capA.json.data?.activate?.available === false && capA.json.data?.suspend?.available === false && capA.json.data?.clone?.available === false && capA.json.data?.clone?.reason === 'STRICT_ROLE_NO_WRITER' && capA.json.data?.activate?.reason === 'LIFECYCLE_ROLE_NOT_PROVISIONED')
    const capAnon = await http('GET', '/supply/rate-plans/capabilities', null)
    const capAgent = await http('GET', '/supply/rate-plans/capabilities', agentCookie)
    check('capabilities require authentication (401) and supply.rates.read (403)', capAnon.status === 401 && capAgent.status === 403)

    const actA = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, adminCookie, { expectedUpdatedAt: v2 })
    check('activate without the lifecycle role: typed 403 RUNTIME_ROLE_OPERATION_PROHIBITED, sanitized', actA.status === 403 && actA.json.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && safe(actA))
    check('activate without the lifecycle role: the plan is still DRAFT with no status audit event', (await planState(draftReady.id)).status === 'DRAFT' && (await statusEvents(draftReady.id)) === 0)
    const vP = await version(adminCookie, plan.id)
    const susA = await http('POST', `/supply/rate-plans/${plan.id}/suspend`, adminCookie, { expectedUpdatedAt: vP, reason: 'Boot smoke suspension' })
    check('suspend without the lifecycle role: typed 403, plan stays ACTIVE, no status audit event', susA.status === 403 && susA.json.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && safe(susA) && (await planState(plan.id)).status === 'ACTIVE' && (await statusEvents(plan.id)) === 0)
    const before = await owner.ratePlan.count({ where: { tenantId: tenantA } })
    const cloneA = await http('POST', `/supply/rate-plans/${plan.id}/clone`, adminCookie, { code: 'CLONE-A' })
    check('clone on the strict role: typed 403, sanitized, no row created', cloneA.status === 403 && cloneA.json.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && safe(cloneA) && (await owner.ratePlan.count({ where: { tenantId: tenantA } })) === before)
    const patchStatus = await http('PATCH', `/supply/rate-plans/${draftReady.id}`, adminCookie, { status: 'ACTIVE' })
    check('PATCH with status is refused (400 RATE_PLAN_STATUS_VIA_LIFECYCLE_ONLY) and nothing changes', patchStatus.status === 400 && patchStatus.json.error?.code === 'RATE_PLAN_STATUS_VIA_LIFECYCLE_ONLY' && (await planState(draftReady.id)).status === 'DRAFT')
    const actAgent = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, agentCookie, { expectedUpdatedAt: v2 })
    check('authorization: a user without supply.rates.manage gets 403 FORBIDDEN on activate', actAgent.status === 403 && actAgent.json.error?.code === 'FORBIDDEN' && (await planState(draftReady.id)).status === 'DRAFT')
    const actAnon = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, null, { expectedUpdatedAt: v2 })
    check('authentication: unauthenticated activate is 401', actAnon.status === 401)
    const actCross = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, bCookie, { expectedUpdatedAt: v2 })
    const susCross = await http('POST', `/supply/rate-plans/${plan.id}/suspend`, bCookie, { expectedUpdatedAt: vP, reason: 'Cross tenant attempt' })
    check('tenant isolation: another tenant gets 404 on activate and suspend, nothing changes', actCross.status === 404 && susCross.status === 404 && (await planState(draftReady.id)).status === 'DRAFT' && (await planState(plan.id)).status === 'ACTIVE')
    const noVersion = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, adminCookie, {})
    check('activate without expectedUpdatedAt is a 400, not a write', noVersion.status === 400 && (await planState(draftReady.id)).status === 'DRAFT')
    await stop()

    // ======== Phase B: lifecycle role provisioned and configured ---------------------------------------------------------------------------
    const opsPassword = randomBytes(24).toString('hex')
    await provisionRatePlanOpsRole(owner, { password: opsPassword })
    const opsUrl = new URL(ownerUrl); opsUrl.username = RATE_PLAN_OPS_LOGIN_ROLE; opsUrl.password = opsPassword
    const opsProbe = new PrismaClient({ datasourceUrl: opsUrl.toString() })
    const opsCert = await certifyRatePlanOpsRole(opsProbe)
    check(`lifecycle role verifier and ${opsCert.probes.length} privilege probes pass as the lifecycle login`, opsCert.ok, JSON.stringify({ role: opsCert.role.failures, probes: opsCert.probes.filter((p) => !p.ok).map((p) => p.name) }))
    await opsProbe.$disconnect()
    check('the runtime credential and the lifecycle credential are different principals', opsUrl.username !== runtimeUrl.username && opsUrl.password !== runtimeUrl.password)
    await boot('B (lifecycle role configured)', { RATE_PLAN_OPS_DATABASE_URL: opsUrl.toString() })

    const capB = await http('GET', '/supply/rate-plans/capabilities', adminCookie)
    check('capabilities (lifecycle role): activate and suspend available, clone still unavailable', capB.status === 200 && capB.json.data?.activate?.available === true && capB.json.data?.suspend?.available === true && capB.json.data?.clone?.available === false)
    const actAgentB = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, agentCookie, { expectedUpdatedAt: await version(adminCookie, draftReady.id) })
    check('authorization is not bypassed by the lifecycle role: no supply.rates.manage is 403 and the plan stays DRAFT', actAgentB.status === 403 && actAgentB.json.error?.code === 'FORBIDDEN' && (await planState(draftReady.id)).status === 'DRAFT')
    const crossB = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, bCookie, { expectedUpdatedAt: await version(adminCookie, draftReady.id) })
    check('tenant isolation holds on the lifecycle role: another tenant gets 404 and the plan stays DRAFT', crossB.status === 404 && (await planState(draftReady.id)).status === 'DRAFT')
    const notReady = await http('POST', `/supply/rate-plans/${draftNoRates.id}/activate`, adminCookie, { expectedUpdatedAt: await version(adminCookie, draftNoRates.id) })
    const failedChecks = (notReady.json.error?.details ?? []).filter((d) => d && typeof d === 'object' && d.ok === false)
    check('a plan with no rates is 409 RATE_PLAN_NOT_READY with structured failed checks, stays DRAFT, no audit event', notReady.status === 409 && notReady.json.error?.code === 'RATE_PLAN_NOT_READY' && failedChecks.length > 0 && (await planState(draftNoRates.id)).status === 'DRAFT' && (await statusEvents(draftNoRates.id)) === 0)
    const staleVersion = await version(adminCookie, draftReady.id)
    const stale = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, adminCookie, { expectedUpdatedAt: new Date(new Date(staleVersion).getTime() - 5_000).toISOString() })
    check('a stale expectedUpdatedAt is 409 RATE_PLAN_CHANGED and nothing is written', stale.status === 409 && stale.json.error?.code === 'RATE_PLAN_CHANGED' && (await planState(draftReady.id)).status === 'DRAFT')
    const actB = await http('POST', `/supply/rate-plans/${draftReady.id}/activate`, adminCookie, { expectedUpdatedAt: staleVersion })
    check('activate of a ready draft succeeds through the lifecycle role (201) and the plan is ACTIVE', actB.status === 201 && (await planState(draftReady.id)).status === 'ACTIVE')
    const ev = await owner.auditEvent.findMany({ where: { tenantId: tenantA, action: 'supply.rate_plan.status_changed', entityId: draftReady.id } })
    check('exactly one status audit event was written, with actor and before/after', ev.length === 1 && ev[0].userId === admin.id && ev[0].payload?.before?.status === 'DRAFT' && ev[0].payload?.after?.status === 'ACTIVE')
    const noReason = await http('POST', `/supply/rate-plans/${plan.id}/suspend`, adminCookie, { expectedUpdatedAt: await version(adminCookie, plan.id), reason: '' })
    check('suspend without a reason is a 400 and the plan stays ACTIVE', noReason.status === 400 && (await planState(plan.id)).status === 'ACTIVE')
    const susB = await http('POST', `/supply/rate-plans/${plan.id}/suspend`, adminCookie, { expectedUpdatedAt: await version(adminCookie, plan.id), reason: 'Boot smoke suspension' })
    check('suspend succeeds through the lifecycle role (201): SUSPENDED with exactly one audit event', susB.status === 201 && (await planState(plan.id)).status === 'SUSPENDED' && (await statusEvents(plan.id)) === 1)
    const cloneB = await http('POST', `/supply/rate-plans/${plan.id}/clone`, adminCookie, { code: 'CLONE-B' })
    check('clone stays refused with the lifecycle role configured (it must not insert rows)', cloneB.status === 403 && cloneB.json.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && (await owner.ratePlan.count({ where: { tenantId: tenantA, code: 'CLONE-B' } })) === 0)
    await stop()

    // ======== Phase C: lifecycle role configured but unusable: sanitized 503, never a fallback to the runtime client --------------------------
    const badUrl = new URL(opsUrl.toString()); badUrl.password = randomBytes(24).toString('hex')
    await boot('C (lifecycle credential rejected)', { RATE_PLAN_OPS_DATABASE_URL: badUrl.toString() })
    const eventsBefore = await statusEvents(plan.id)
    const actC = await http('POST', `/supply/rate-plans/${plan.id}/activate`, adminCookie, { expectedUpdatedAt: (await planState(plan.id)).updatedAt.toISOString() })
    check('a rejected lifecycle credential is a sanitized 503 RATE_PLAN_OPS_UNAVAILABLE, never a fallback write', actC.status === 503 && actC.json.error?.code === 'RATE_PLAN_OPS_UNAVAILABLE' && safe(actC) && (await planState(plan.id)).status === 'SUSPENDED' && (await statusEvents(plan.id)) === eventsBefore, `status=${actC.status} code=${actC.json.error?.code}`)

    // ======== Phase D: four-eye activation on the strict runtime role with the lifecycle role (ADR 0057, S5) -------------------------------------
    await stop()
    await boot('D (approval required)', { RATE_PLAN_OPS_DATABASE_URL: opsUrl.toString(), RATE_PLAN_ACTIVATION_APPROVAL: 'required' })
    const admin2Cookie = await login(admin2.email); const adminCookieD = await login(admin.email); const agentCookieD = await login(agent.email); const bCookieD = await login(badmin.email)
    const capD = await http('GET', '/supply/rate-plans/capabilities', adminCookieD)
    check('capabilities report activation approval as required', capD.status === 200 && capD.json.data?.activationApproval === 'required')
    const directD = await http('POST', `/supply/rate-plans/${draftApproval.id}/activate`, adminCookieD, { expectedUpdatedAt: await version(adminCookieD, draftApproval.id) })
    check('D: a direct activation is 409 RATE_PLAN_APPROVAL_REQUIRED and the plan stays DRAFT', directD.status === 409 && directD.json.error?.code === 'RATE_PLAN_APPROVAL_REQUIRED' && (await planState(draftApproval.id)).status === 'DRAFT' && safe(directD))
    const reqD = await http('POST', `/supply/rate-plans/${draftApproval.id}/activation-request`, adminCookieD, { requestId: `${suffix}-d1`, reason: 'Boot smoke four-eye request', expectedUpdatedAt: await version(adminCookieD, draftApproval.id) })
    const approvalId = reqD.json.data?.id
    check('D: a request is filed (201) as PENDING on the strict runtime role', reqD.status === 201 && reqD.json.data?.status === 'PENDING' && Boolean(approvalId))
    const selfD = await http('POST', `/supply/rate-plan-approvals/${approvalId}/approve`, adminCookieD, { reason: 'self' })
    check('D: the requester cannot approve their own request (403)', selfD.status === 403 && (await owner.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status === 'PENDING')
    const noPermD = await http('POST', `/supply/rate-plan-approvals/${approvalId}/approve`, agentCookieD, { reason: 'no permission' })
    check('D: a user without supply.rates.manage cannot approve (403)', noPermD.status === 403)
    const crossD = await http('POST', `/supply/rate-plan-approvals/${approvalId}/approve`, bCookieD, { reason: 'other tenant' })
    check('D: another tenant gets 404 on the approval', crossD.status === 404)
    const okD = await http('POST', `/supply/rate-plan-approvals/${approvalId}/approve`, admin2Cookie, { reason: 'Reviewed' })
    check('D: a different manager approves (201) and the plan is still DRAFT', okD.status === 201 && okD.json.data?.status === 'APPROVED' && (await planState(draftApproval.id)).status === 'DRAFT')
    const execD = await http('POST', `/supply/rate-plan-approvals/${approvalId}/execute`, admin2Cookie)
    check('D: execute activates through the lifecycle role (201) and the plan is ACTIVE', execD.status === 201 && execD.json.data?.status === 'ACTIVE' && (await planState(draftApproval.id)).status === 'ACTIVE' && safe(execD))
    const evD = await owner.auditEvent.findMany({ where: { tenantId: tenantA, action: 'supply.rate_plan.status_changed', entityId: draftApproval.id } })
    check('D: exactly one status audit event records requester, approver and executor', evD.length === 1 && evD[0].userId === admin2.id && evD[0].payload?.activation?.mode === 'approved' && evD[0].payload?.activation?.requestedById === admin.id && evD[0].payload?.activation?.approvedById === admin2.id)
    const replayD = await http('POST', `/supply/rate-plan-approvals/${approvalId}/execute`, admin2Cookie)
    check('D: an approval cannot be used twice (409) and no second audit event is written', replayD.status === 409 && (await statusEvents(draftApproval.id)) === 1)

    // ======== Phase E: clone through its own DRAFT-only role on the strict runtime login (ADR 0057, S8) --------------------------------------------
    await stop()
    const clonePassword = randomBytes(24).toString('hex')
    await provisionRatePlanCloneRole(owner, { password: clonePassword })
    const cloneUrl = new URL(ownerUrl); cloneUrl.username = RATE_PLAN_CLONE_LOGIN_ROLE; cloneUrl.password = clonePassword
    const cloneProbe = new PrismaClient({ datasourceUrl: cloneUrl.toString() })
    const cloneCert = await certifyRatePlanCloneRole(cloneProbe)
    check(`clone role verifier and ${cloneCert.probes.length} privilege probes pass as the clone login`, cloneCert.ok, JSON.stringify({ role: cloneCert.role.failures, probes: cloneCert.probes.filter((p) => !p.ok).map((p) => p.name) }))
    await cloneProbe.$disconnect()
    check('the clone credential is a different principal from the runtime and lifecycle credentials', cloneUrl.username !== runtimeUrl.username && cloneUrl.username !== opsUrl.username && cloneUrl.password !== runtimePassword)
    await boot('E (clone role configured)', { RATE_PLAN_OPS_DATABASE_URL: opsUrl.toString(), RATE_PLAN_CLONE_DATABASE_URL: cloneUrl.toString(), RATE_PLAN_ACTIVATION_APPROVAL: 'required' })
    const adminCookieE = await login(admin.email); const agentCookieE = await login(agent.email); const bCookieE = await login(badmin.email)
    const capE = await http('GET', '/supply/rate-plans/capabilities', adminCookieE)
    check('capabilities: clone is now available', capE.status === 200 && capE.json.data?.clone?.available === true)
    const cloneBefore = await owner.ratePlan.count({ where: { tenantId: tenantA } })
    const cloneE = await http('POST', `/supply/rate-plans/${draftApproval.id}/clone`, adminCookieE, { code: 'CLONE-E' })
    const cloned = await owner.ratePlan.findFirst({ where: { tenantId: tenantA, code: 'CLONE-E' } })
    check('E: clone succeeds on the strict runtime login (201) and creates a DRAFT with no pool, rates or stock', cloneE.status === 201 && cloned?.status === 'DRAFT' && cloned?.inventoryPoolId === null && (await owner.dailyRate.count({ where: { ratePlanId: cloned.id } })) === 0 && (await owner.dailyAvailability.count({ where: { ratePlanId: cloned.id } })) === 0 && (await owner.ratePlan.count({ where: { tenantId: tenantA } })) === cloneBefore + 1 && safe(cloneE))
    const [{ n: cloneConns }] = await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = '${RATE_PLAN_CLONE_LOGIN_ROLE}' AND datname = current_database()`)
    check('E: the insert was made over the clone login, not the runtime login', cloneConns > 0)
    const evE = await owner.auditEvent.findMany({ where: { tenantId: tenantA, action: 'supply.rate_plan.cloned', entityId: cloned?.id } })
    check('E: one audit event records the actor, attributed to the user', evE.length === 1 && evE[0].userId === admin.id && evE[0].actorType === 'USER')
    const dupE = await http('POST', `/supply/rate-plans/${draftApproval.id}/clone`, adminCookieE, { code: 'CLONE-E' })
    check('E: a duplicate code is 409 RATE_PLAN_CODE_EXISTS and nothing more is written', dupE.status === 409 && dupE.json.error?.code === 'RATE_PLAN_CODE_EXISTS' && (await owner.ratePlan.count({ where: { tenantId: tenantA } })) === cloneBefore + 1)
    const noPermE = await http('POST', `/supply/rate-plans/${draftApproval.id}/clone`, agentCookieE, { code: 'CLONE-E2' })
    check('E: a user without supply.rates.manage is 403 and nothing is written', noPermE.status === 403 && (await owner.ratePlan.count({ where: { code: 'CLONE-E2' } })) === 0)
    const crossE = await http('POST', `/supply/rate-plans/${draftApproval.id}/clone`, bCookieE, { code: 'CLONE-E3' })
    check('E: another tenant gets 404 and nothing is written', crossE.status === 404 && (await owner.ratePlan.count({ where: { code: 'CLONE-E3' } })) === 0)
    check('E: the clone cannot be activated without approval (the only way to a sellable plan is still the approval flow)', (await http('POST', `/supply/rate-plans/${cloned.id}/activate`, adminCookieE, { expectedUpdatedAt: await version(adminCookieE, cloned.id) })).json.error?.code === 'RATE_PLAN_APPROVAL_REQUIRED')
    await stop()
    // Same environment WITHOUT the clone credential: clone is refused again, with nothing written.
    await boot('F (lifecycle role only)', { RATE_PLAN_OPS_DATABASE_URL: opsUrl.toString() })
    const adminCookieF = await login(admin.email)
    const cloneF = await http('POST', `/supply/rate-plans/${draftApproval.id}/clone`, adminCookieF, { code: 'CLONE-F' })
    check('F: without the clone credential clone is refused again (403) and no row is created', cloneF.status === 403 && cloneF.json.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && (await owner.ratePlan.count({ where: { code: 'CLONE-F' } })) === 0)
  } finally {
    await stop()
    await deprovisionRatePlanOpsRole(owner).catch(() => undefined)
    await deprovisionRatePlanCloneRole(owner).catch(() => undefined)
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
