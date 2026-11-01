import test from 'node:test'
import assert from 'node:assert/strict'
import { SharedConnectorGate, sharedGateKey } from '../src/xml/shared-gate.ts'
import { InProcessGate } from '../src/xml/xml-transport.ts'

const read = { name: 'search', kind: 'read' }
const flush = () => new Promise((resolve) => setImmediate(resolve))
const gate = (store, extra = {}) => new SharedConnectorGate({ tenantId: 'tenant-a', connectorId: 'connector-a', store, whenStoreUnavailable: new InProcessGate({ maxConcurrent: 1 }), ...extra })
function recordingStore(result = { status: 'acquired', slotId: 'slot-1' }) {
  const calls = []
  return {
    calls,
    acquire: async (key, limits) => { calls.push(['acquire', key, limits]); return typeof result === 'function' ? result() : result },
    release: async (key, slotId, outcome) => { calls.push(['release', key, slotId, outcome]) },
  }
}

test('acquire goes to the store with the connector key and limits; release reports the outcome once', async () => {
  const store = recordingStore()
  const release = await gate(store, { limits: { maxConcurrent: 8 } }).acquire(read)
  release('provider_failure')
  release('ok')
  await flush()
  assert.deepEqual(store.calls, [
    ['acquire', 'fbeds:v1:gate:tenant-a:connector-a', { maxConcurrent: 8, failureThreshold: 5, openMs: 30_000, slotTtlMs: 60_000 }],
    ['release', 'fbeds:v1:gate:tenant-a:connector-a', 'slot-1', 'provider_failure'],
  ])
})

test('an open circuit is refused as circuit_open with the remaining time, and nothing is released', async () => {
  const store = recordingStore({ status: 'open', retryAfterMs: 1234 })
  await assert.rejects(gate(store).acquire(read), (e) => e.code === 'circuit_open' && e.delivery === 'not_sent' && e.retryAfterMs === 1234)
  assert.equal(store.calls.length, 1)
})

test('a full gate is refused as busy', async () => {
  await assert.rejects(gate(recordingStore({ status: 'busy' })).acquire(read), (e) => e.code === 'busy')
})

test('when the store is unreachable the declared per-task gate decides, and the outage is reported', async () => {
  const events = []
  const store = { acquire: async () => { throw new Error('ECONNREFUSED') }, release: async () => { throw new Error('unreachable') } }
  const shared = gate(store, { event: (e) => events.push(e) })
  const release = await shared.acquire(read)
  await assert.rejects(shared.acquire(read), (e) => e.code === 'busy', 'the fallback gate allows one call per task')
  release('ok')
  const again = await shared.acquire(read)
  again('ok')
  assert.deepEqual(events.map((e) => e.event), ['store_unavailable', 'store_unavailable', 'store_unavailable'])
  assert.equal(events[0].gateKey, 'fbeds:v1:gate:tenant-a:connector-a')
})

test('a failed release is reported, never thrown at the caller', async () => {
  const events = []
  const store = { acquire: async () => ({ status: 'acquired', slotId: 's' }), release: async () => { throw new Error('timeout') } }
  const release = await gate(store, { event: (e) => events.push(e.event) }).acquire(read)
  assert.doesNotThrow(() => release('ok'))
  await flush()
  assert.deepEqual(events, ['release_failed'])
})

test('a throwing event sink cannot fail the call', async () => {
  const store = { acquire: async () => { throw new Error('down') }, release: async () => undefined }
  const release = await gate(store, { event: () => { throw new Error('sink down') } }).acquire(read)
  release('ok')
})

test('ids and limits are validated at construction', () => {
  const store = recordingStore()
  assert.throws(() => gate(store, { tenantId: 'tenant a' }), (e) => e.code === 'configuration')
  assert.throws(() => gate(store, { connectorId: 'x:y' }), (e) => e.code === 'configuration')
  for (const limits of [{ maxConcurrent: 0 }, { failureThreshold: 1.5 }, { openMs: -1 }, { slotTtlMs: Number.NaN }]) {
    assert.throws(() => gate(store, { limits }), (e) => e.code === 'configuration')
  }
  assert.equal(sharedGateKey('t1', 'c1'), 'fbeds:v1:gate:t1:c1')
})
