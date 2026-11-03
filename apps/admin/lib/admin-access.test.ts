import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adminConsoleMemberships, adminConsoleRole, sessionMayUseAdminConsole } from '@bedbanks/contracts'
import { highestAdminConsoleRole } from './auth/admin-access'
import { decideAdminEdgeAccess } from './auth/edge-guard'
import { pinActiveTenantHeader, resolveActiveTenantId } from './api/tenant-context'

const root = join(import.meta.dirname, '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

test('membership roles map to ADMIN / SUPER_ADMIN and nothing else', () => {
  assert.equal(adminConsoleRole('owner'), 'ADMIN')
  assert.equal(adminConsoleRole('ADMIN'), 'ADMIN')
  assert.equal(adminConsoleRole('Admin'), 'ADMIN')
  assert.equal(adminConsoleRole('SUPER_ADMIN'), 'SUPER_ADMIN')
  assert.equal(adminConsoleRole('super-admin'), 'SUPER_ADMIN')
  assert.equal(adminConsoleRole('platform_admin'), 'SUPER_ADMIN')
  assert.equal(adminConsoleRole('member'), null)
  assert.equal(adminConsoleRole('finance'), null)
  assert.equal(adminConsoleRole('agent'), null)
  assert.equal(adminConsoleRole(''), null)
  assert.equal(adminConsoleRole(undefined), null)
})

test('a session may use the Admin console only with an admin membership', () => {
  assert.equal(sessionMayUseAdminConsole([{ role: 'member' }]), false)
  assert.equal(sessionMayUseAdminConsole([{ role: 'owner' }]), true)
  assert.equal(sessionMayUseAdminConsole([{ role: 'member' }, { role: 'SUPER_ADMIN' }]), true)
  assert.deepEqual(adminConsoleMemberships([
    { tenantId: 'a', role: 'member' },
    { tenantId: 'b', role: 'owner' },
  ]).map((m) => m.tenantId), ['b'])
  assert.equal(highestAdminConsoleRole([{ role: 'owner' }, { role: 'SUPER_ADMIN' }]), 'SUPER_ADMIN')
  assert.equal(highestAdminConsoleRole([{ role: 'member' }]), null)
})

test('tenant selection never honours a membership that is not ADMIN / SUPER_ADMIN', () => {
  const mixed = [{ tenantId: 'agency', role: 'member' }, { tenantId: 'ops', role: 'owner' }]
  assert.equal(resolveActiveTenantId(adminConsoleMemberships(mixed), 'agency'), 'ops')
  assert.equal(resolveActiveTenantId(adminConsoleMemberships(mixed), 'ops'), 'ops')
})

test('edge access requires a well-formed opaque token, not cookie presence', () => {
  assert.equal(decideAdminEdgeAccess({ pathname: '/login', sessionCookie: undefined }), 'public')
  assert.equal(decideAdminEdgeAccess({ pathname: '/_next/static/x', sessionCookie: undefined }), 'static')
  assert.equal(decideAdminEdgeAccess({ pathname: '/dashboard', sessionCookie: undefined }), 'login')
  assert.equal(decideAdminEdgeAccess({ pathname: '/dashboard', sessionCookie: 'not-a-token' }), 'login')
  assert.equal(decideAdminEdgeAccess({ pathname: '/dashboard', sessionCookie: 'A'.repeat(64) }), 'login', 'must be lowercase hex')
  assert.equal(decideAdminEdgeAccess({ pathname: '/hotels', sessionCookie: 'ab'.repeat(32) }), 'allow')
})

test('server tenant header overwrites a caller-supplied value', () => {
  assert.deepEqual(
    pinActiveTenantHeader({ 'x-fbeds-tenant-id': 'forged', Accept: 'application/json' }, 'tenant-from-session'),
    { 'x-fbeds-tenant-id': 'tenant-from-session', Accept: 'application/json' },
  )
  assert.throws(() => pinActiveTenantHeader({}, ' tenant '), /normalized tenant/)
})

test('dashboard layout validates the session against /auth/me and ADMIN / SUPER_ADMIN', () => {
  const layout = read('app', '(dashboard)', 'layout.tsx')
  assert.match(layout, /requireAdminSession/)
  assert.doesNotMatch(layout, /requireSession\(\)/)
  assert.match(read('lib', 'auth', 'session.ts'), /sessionMayUseAdminConsole/)
  assert.match(read('lib', 'auth', 'session.ts'), /\/login\?denied=role/)
})

test('Next 16 has one proxy entry for the auth gate and API rewrite', () => {
  assert.equal(existsSync(join(root, 'middleware.ts')), false)
  assert.match(read('proxy.ts'), /export function proxy/)
  assert.match(read('proxy.ts'), /decideAdminEdgeAccess/)
  assert.match(read('proxy.ts'), /resolveApiDestination/)
})

test('login refuses a session that is not ADMIN / SUPER_ADMIN and revokes it', () => {
  const action = read('lib', 'auth', 'actions.ts')
  const login = action.slice(action.indexOf('export async function loginAction'))
  assert.match(login, /sessionMayUseAdminConsole\(identity\.memberships\)/)
  assert.ok(login.indexOf('sessionMayUseAdminConsole') < login.indexOf('cookieStore.set'), 'refuse before copying the cookie')
  assert.match(login, /authApi\.logout/)
  assert.match(login, /not authorized for the Admin console/)
})

test('tenant-scoped server requests pin the session tenant last', () => {
  const src = read('lib', 'api', 'tenant-server-request.ts')
  assert.match(src, /adminConsoleMemberships/)
  assert.match(src, /pinActiveTenantHeader/)
  assert.match(src, /resolveActiveTenantId/)
  assert.match(src, /readSelectedTenantId/)
})
