import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldApplyTenantResponse } from './tenant-response.ts'

test('Given the selected tenant, When the response was requested for that tenant, Then it is applied', () => {
  assert.equal(shouldApplyTenantResponse('tenant-a', 'tenant-a'), true)
})

test('Given an agent who belongs to two tenants, When the active tenant differs from the request, Then the response is not applied', () => {
  assert.equal(shouldApplyTenantResponse('tenant-a', 'tenant-b'), false)
  assert.equal(shouldApplyTenantResponse('tenant-b', 'tenant-a'), false)
})

test('Given a stale response from the previously selected tenant, When the workspace has changed, Then it is not applied', () => {
  const requested = 'tenant-a'
  const active = 'tenant-b'
  assert.equal(shouldApplyTenantResponse(requested, active), false)
})

test('Given a tenant switch while a request is in flight, When the response arrives, Then only the current tenant is applied', () => {
  let active = 'tenant-a'
  const requested = active
  active = 'tenant-b'
  assert.equal(shouldApplyTenantResponse(requested, active), false)
  assert.equal(shouldApplyTenantResponse(active, active), true)
  assert.equal(shouldApplyTenantResponse('', active), false)
})
