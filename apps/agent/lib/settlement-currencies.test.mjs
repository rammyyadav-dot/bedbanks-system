import assert from 'node:assert/strict'
import test from 'node:test'
import { agentSession, settlementCurrenciesFromContext } from './api-client.ts'

test('the Agent offers only the currencies the server enables, and falls back to AED (ADR 0029)', () => {
  assert.deepEqual(settlementCurrenciesFromContext(['AED']), ['AED'])
  assert.deepEqual(settlementCurrenciesFromContext(['AED', 'USD', 'AED']), ['AED', 'USD'])
  for (const bad of [undefined, null, 'AED', [], [1, 2], ['aed'], ['AEDX'], {}]) assert.deepEqual(settlementCurrenciesFromContext(bad), ['AED'], JSON.stringify(bad))
  const user = { id: 'u', email: 'a@b.test', name: null, status: 'ACTIVE' }
  assert.deepEqual(agentSession({ user, memberships: [] }, false).settlementCurrencies, ['AED'])
  assert.deepEqual(agentSession({ user, memberships: [] }, true, ['AED', 'USD']).settlementCurrencies, ['AED', 'USD'])
})
