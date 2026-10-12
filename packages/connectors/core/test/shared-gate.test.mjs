import test from 'node:test'
import assert from 'node:assert/strict'
import { SharedConnectorGate, SupplierCallError } from '../src/index.ts'

function memory() {
  const locks = new Map(); const store = new Map()
  return {
    coordination: { acquire: async (k) => (locks.has(k) ? null : (locks.set(k, 't'), { key: k, token: 't' })), release: async (l) => { locks.delete(l.key) } },
    cache: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v) }, delete: async (k) => { store.delete(k) } },
    store,
  }
}
const op = { name: 'search', kind: 'read' }
const gate = (m, o = {}) => new SharedConnectorGate(m.coordination, m.cache, { tenantId: 't1', connectorId: 'c1', ...o })
const code = (c) => (e) => e instanceof SupplierCallError && e.code === c && e.delivery === 'not_sent'
const tick = () => new Promise((r) => setImmediate(r))

test('concurrency is shared across gate instances (workers)', async () => {
  const m = memory(); const a = gate(m, { maxConcurrent: 1 }); const b = gate(m, { maxConcurrent: 1 })
  const release = await a.acquire(op)
  await assert.rejects(b.acquire(op), code('busy'))
  release('ok'); await tick()
  await (await b.acquire(op))('ok')
})
test('pacing interval is enforced across workers', async () => {
  const m = memory(); const a = gate(m, { minIntervalMs: 1000 }); const b = gate(m, { minIntervalMs: 1000 })
  await (await a.acquire(op))('ok')
  await assert.rejects(b.acquire(op), code('rate_limited'))
})
test('circuit opens for every worker after repeated provider failures', async () => {
  const m = memory(); const a = gate(m, { failureThreshold: 2 }); const b = gate(m, { failureThreshold: 2 })
  for (let i = 0; i < 2; i++) { (await a.acquire(op))('provider_failure'); await tick() }
  await assert.rejects(b.acquire(op), code('circuit_open'))
})
test('fails closed when coordination is unavailable', async () => {
  const none = { acquire: async () => null, release: async () => {} }
  await assert.rejects(new SharedConnectorGate(none, memory().cache, { tenantId: 't1', connectorId: 'c1' }).acquire(op), code('busy'))
  const broken = { acquire: async () => { throw new Error('redis down') }, release: async () => {} }
  await assert.rejects(new SharedConnectorGate(broken, memory().cache, { tenantId: 't1', connectorId: 'c1' }).acquire(op), code('busy'))
})
test('keys are tenant and connector scoped; bad ids refused', async () => {
  const m = memory(); await (await gate(m).acquire(op))('ok'); assert.throws(() => gate(m, { tenantId: 'a:b' }), SupplierCallError)
})
