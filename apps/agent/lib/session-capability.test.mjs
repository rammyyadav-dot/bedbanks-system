import assert from 'node:assert/strict'
import test from 'node:test'
import { agentSession, bookingEnabledFromContext } from './api-client.ts'

const alice = { id: 'user-a', email: 'a@example.test', name: 'Alice Agent', status: 'ACTIVE' }
const blake = { id: 'user-b', email: 'b@example.test', name: 'Blake Agent', status: 'ACTIVE' }
const membership = { tenantId: 'tenant-a', tenantName: 'Preview Agency', role: 'AGENT' }

test('bookingEnabled is true only for an explicit boolean true', () => {
  assert.equal(bookingEnabledFromContext(true), true)
  assert.equal(bookingEnabledFromContext(false), false)
  for (const value of [undefined, null, 'true', 1, 0, 'false', {}, []]) {
    assert.equal(bookingEnabledFromContext(value), false)
  }
})

test('effective capabilities stay with the tenant that returned them', () => {
  const first = agentSession({ user: alice, memberships: [membership], capabilities: ['hotel.search', 'not-a-grant'], capabilityTenantId: 'tenant-a', bookingServicingEnabled: true, fundingEnabled: false }, false)
  assert.deepEqual(first.capabilities, ['hotel.search'])
  assert.equal(first.capabilityTenantId, 'tenant-a')
  assert.equal(first.bookingServicingEnabled, true)
  assert.equal(first.fundingEnabled, false)
  const second = agentSession({ user: alice, memberships: [membership, { tenantId: 'tenant-b', tenantName: 'Other', role: 'AGENT' }], capabilities: ['finance.read'], capabilityTenantId: 'tenant-b' }, false)
  assert.deepEqual(second.capabilities, ['finance.read'])
  assert.equal(second.capabilityTenantId, 'tenant-b')
  assert.deepEqual(agentSession({ user: alice, memberships: [membership] }, true).capabilities, [])
})

test('a new context replaces the previous account capability', () => {
  const enabled = agentSession({ user: alice, memberships: [membership] }, true)
  const disabled = agentSession({ user: blake, memberships: [{ ...membership, tenantId: 'tenant-b' }] }, false)
  assert.equal(enabled.bookingEnabled, true)
  assert.equal(disabled.bookingEnabled, false)
  assert.equal(disabled.user.id, 'user-b')
  const refreshed = agentSession(enabled, undefined)
  assert.equal(refreshed.user.id, 'user-a')
  assert.equal(refreshed.bookingEnabled, false)
  assert.equal(agentSession(enabled, false).bookingEnabled, false)
})
