import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TenantControlPermission } from '@bedbanks/contracts'
import {
  agencyAccessLabels,
  canCreateTenant,
  membershipRoleLabel,
  tenantApiPath,
  tenantDirectoryQuery,
  tenantLifecycleClass,
  tenantLifecycleLabel,
  tenantPath,
  tenantUsersPath,
} from './tenants-ui'

const root = join(import.meta.dirname, '..')

test('tenant paths encode the identifier and nest users under the tenant', () => {
  assert.equal(tenantPath('abc/def'), '/tenants/abc%2Fdef')
  assert.equal(tenantUsersPath('t1'), '/tenants/t1/users')
  assert.equal(tenantApiPath('/platform/tenants/:tenantId/summary', 't1'), '/platform/tenants/t1/summary')
  assert.equal(
    tenantApiPath('/platform/tenants/:tenantId/approvals/:approvalId', 't1', { approvalId: 'a2' }),
    '/platform/tenants/t1/approvals/a2',
  )
})

test('directory lifecycle filters map pending approval to the review stage, not a fake status', () => {
  assert.equal(tenantDirectoryQuery({
    search: ' gulf ', lifecycle: 'REVIEW', classification: '', country: '', createdFrom: '', createdTo: '', sort: 'name', order: 'asc', page: 2,
  }).toString(), 'search=gulf&stage=REVIEW&sort=name&order=asc&page=2')
  assert.equal(tenantDirectoryQuery({
    search: '', lifecycle: 'ACTIVE', classification: 'BUYER', country: 'AE', createdFrom: '', createdTo: '', sort: 'createdAt', order: 'desc', page: 1,
  }).toString(), 'status=ACTIVE&classification=BUYER&country=AE&sort=createdAt&order=desc&page=1')
  assert.equal(tenantDirectoryQuery({
    search: '', lifecycle: 'SUSPENDED', classification: '', country: '', createdFrom: '', createdTo: '', sort: 'name', order: 'asc', page: 1,
  }).get('status'), 'SUSPENDED')
  assert.equal(tenantDirectoryQuery({
    search: '', lifecycle: '', classification: '', country: '', createdFrom: '', createdTo: '', sort: 'name', order: 'asc', page: 1,
  }).has('status'), false)
})

test('lifecycle labels distinguish pending review from suspension without inventing a third tenant status', () => {
  assert.equal(tenantLifecycleLabel('SUSPENDED', 'REVIEW'), 'Pending approval')
  assert.equal(tenantLifecycleClass('SUSPENDED', 'REVIEW'), 'review')
  assert.equal(tenantLifecycleLabel('ACTIVE', 'APPROVED'), 'Active')
  assert.equal(tenantLifecycleClass('ACTIVE', 'APPROVED'), 'active')
  assert.equal(tenantLifecycleLabel('SUSPENDED', 'APPROVED'), 'Suspended')
})

test('agency access labels are derived from membership and formal keys, never from an AGENCY_* assignment enum', () => {
  assert.deepEqual(agencyAccessLabels('owner', null, ['booking.view.agency', 'finance.read']), ['Agency administration', 'Booking', 'Finance'])
  assert.deepEqual(agencyAccessLabels('member', null, ['booking.read']), ['Booking'])
  assert.deepEqual(agencyAccessLabels('member', null, []), ['Membership only'])
  assert.deepEqual(agencyAccessLabels('owner', '2026-01-01T00:00:00.000Z', ['finance.read']), ['Revoked'])
  assert.equal(membershipRoleLabel('owner'), 'Tenant administrator')
  assert.equal(membershipRoleLabel('member'), 'Tenant member')
  const create: TenantControlPermission[] = ['platform.tenants.create', 'platform.tenants.memberships.manage']
  assert.equal(canCreateTenant({ authoringConfigured: true, permissions: create }), true)
  assert.equal(canCreateTenant({ authoringConfigured: false, permissions: create }), false)
  assert.equal(canCreateTenant({ authoringConfigured: true, permissions: ['platform.tenants.read'] }), false)
})

test('Tenants module pages exist as dedicated App Router routes, not placeholders', () => {
  for (const rel of ['tenants/page.tsx', 'tenants/new/page.tsx', 'tenants/[id]/page.tsx', 'tenants/[id]/users/page.tsx']) {
    const path = join(root, 'app', '(dashboard)', rel)
    assert.ok(existsSync(path), path)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /FeatureUnavailable/)
  }
  const directory = readFileSync(join(root, 'components/tenants/TenantDirectory.tsx'), 'utf8')
  assert.match(directory, /\/tenants\/new/)
  assert.doesNotMatch(directory, /setWizard/)
  const detail = readFileSync(join(root, 'components/tenants/TenantDetail.tsx'), 'utf8')
  assert.match(detail, /tenantUsersPath/)
  assert.doesNotMatch(detail, /tab==='members'/)
  const users = readFileSync(join(root, 'components/tenants/TenantUsers.tsx'), 'utf8')
  assert.match(users, /routes\.platform\.tenantMemberships/)
  assert.match(readFileSync(join(root, 'components/tenants/useTenantControl.ts'), 'utf8'), /Idempotency-Key/)
  assert.match(readFileSync(join(root, 'components/tenants/TenantShell.tsx'), 'utf8'), /role="alert"/)
  assert.doesNotMatch(users, /value="AGENCY_ADMIN"|value="AGENCY_BOOKER"|value="AGENCY_FINANCE"|Cognito/)
})
