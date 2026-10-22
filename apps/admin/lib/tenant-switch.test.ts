import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeMembership, resolveActiveTenantId } from './api/tenant-context'

const root = join(import.meta.dirname, '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')
const memberships = [{ tenantId: 'a', role: 'member' }, { tenantId: 'b', role: 'owner' }, { tenantId: 'c', role: 'member' }]

test('a stored selection is honoured only when it is one of the session memberships', () => {
  assert.equal(resolveActiveTenantId(memberships, 'c'), 'c')
  assert.equal(resolveActiveTenantId(memberships, 'a'), 'a')
  assert.equal(resolveActiveTenantId(memberships, 'forged-tenant'), 'b', 'a foreign id falls back to the default')
  assert.equal(resolveActiveTenantId(memberships, ''), 'b')
  assert.equal(resolveActiveTenantId(memberships, null), 'b')
  assert.equal(resolveActiveTenantId(memberships), 'b')
  assert.equal(resolveActiveTenantId([], 'a'), null, 'no membership means no tenant, whatever the cookie says')
})

test('labels follow the selected tenant', () => {
  assert.equal(activeMembership(memberships, 'c')?.role, 'member')
  assert.equal(activeMembership(memberships, 'nope')?.tenantId, 'b')
})

test('switchTenantAction validates against fresh server-side memberships and stores an httpOnly cookie', () => {
  const src = read('lib', 'auth', 'actions.ts')
  const action = src.slice(src.indexOf('export async function switchTenantAction'))
  assert.match(action, /await getSession\(\)/, 'identity comes from /auth/me, not from the client')
  assert.match(action, /identity\.memberships\.some\(/)
  assert.ok(action.indexOf('memberships.some') < action.indexOf('cookieStore.set'), 'validate before writing the cookie')
  assert.match(action, /httpOnly: true, secure: true, sameSite: 'lax'/)
  assert.match(action, /if \(!identity\) redirect\('\/login'\)/)
})

test('the selection never outlives or crosses a session', () => {
  const src = read('lib', 'auth', 'actions.ts')
  assert.equal(src.match(/cookieStore\.delete\(ACTIVE_TENANT_COOKIE\)/g)?.length, 2, 'cleared on login and on logout')
})

test('the layout resolves the cookie against memberships and the shell remounts per tenant', () => {
  assert.match(read('app', '(dashboard)', 'layout.tsx'), /resolveActiveTenantId\(identity\.memberships, await readSelectedTenantId\(\)\)/)
  const shell = read('components', 'layout', 'AdminShell.tsx')
  assert.doesNotMatch(shell, /pickActiveTenantId/, 'the shell no longer picks its own tenant')
  assert.match(shell, /<RouteGuard key=\{activeTenantId/, 'page state from the previous tenant is dropped on switch')
})

test('the switcher trusts nothing client-side and hides for single-tenant users', () => {
  const src = read('components', 'layout', 'TenantSwitcher.tsx')
  assert.match(src, /memberships\.length < 2\) return null/)
  assert.match(src, /switchTenantAction\(tenantId\)/)
  assert.doesNotMatch(src, /document\.cookie|localStorage|sessionStorage/, 'selection is never stored in script-readable state')
})
