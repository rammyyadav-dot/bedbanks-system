import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NON_EXPIRING_PATHS, SESSION_EXPIRED_EVENT, announceSessionExpired } from './session-events.mjs'

test('announcing dispatches the expiry event on the target and tolerates no target', () => {
  const seen = []
  announceSessionExpired({ dispatchEvent: (event) => { seen.push(event.type); return true } })
  assert.deepEqual(seen, [SESSION_EXPIRED_EVENT])
  assert.doesNotThrow(() => announceSessionExpired(null))
})

test('login and the initial context probe never announce an expired session', () => {
  assert.deepEqual([...NON_EXPIRING_PATHS].sort(), ['/agent/context', '/auth/login'])
})
