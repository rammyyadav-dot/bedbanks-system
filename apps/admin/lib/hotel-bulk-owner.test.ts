import test from 'node:test'
import assert from 'node:assert/strict'
import { BULK_OWNER_MAX, assignOwners, bulkOwnerProblem, type BulkOwnerDeps } from './hotel-bulk-owner'

const deps = (over: Partial<BulkOwnerDeps> = {}, saved: string[] = []): BulkOwnerDeps => ({
  getToken: async (id) => ({ token: `t-${id}`, currentOwnerUserId: id === 'same' ? 'u1' : null }),
  save: async (id, body) => { saved.push(`${id}:${body.expectedToken}:${body.ownerUserId}:${body.reason}`); return { replayed: false } },
  newKey: () => 'k',
  ...over,
})

test('input problems are refused before any call', () => {
  assert.match(bulkOwnerProblem([], 'u1', 'why') ?? '', /at least one/)
  assert.match(bulkOwnerProblem(Array.from({ length: BULK_OWNER_MAX + 1 }, (_, i) => `h${i}`), 'u1', 'why') ?? '', /At most/)
  assert.match(bulkOwnerProblem(['a', 'a'], 'u1', 'why') ?? '', /duplicates/)
  assert.match(bulkOwnerProblem(['a'], 'u1', ' ') ?? '', /reason/)
  assert.match(bulkOwnerProblem(['a'], '', 'why') ?? '', /owner/)
  assert.equal(bulkOwnerProblem(['a'], null, 'why'), null)
})

test('each hotel is saved with its own fresh token; unchanged hotels are skipped', async () => {
  const saved: string[] = []
  const r = await assignOwners(['a', 'same', 'b'], 'u1', ' handover ', deps({}, saved))
  assert.deepEqual(r.map((x) => x.status), ['assigned', 'unchanged', 'assigned'])
  assert.deepEqual(saved, ['a:t-a:u1:handover', 'b:t-b:u1:handover'])
})

test('one failure does not stop the others and is reported per hotel', async () => {
  const r = await assignOwners(['a', 'bad', 'c'], null, 'cleanup', deps({ getToken: async (id) => ({ token: id, currentOwnerUserId: 'u9' }), save: async (id) => { if (id === 'bad') throw new Error('stale'); return { replayed: false } } }))
  assert.deepEqual(r, [{ hotelId: 'a', status: 'assigned' }, { hotelId: 'bad', status: 'failed', message: 'stale' }, { hotelId: 'c', status: 'assigned' }])
})

test('supplied idempotency keys are reused so a retry replays', async () => {
  const used: string[] = []
  await assignOwners(['a'], 'u1', 'why', deps({ save: async (_id, body) => { used.push(body.idempotencyKey); return { replayed: false } } }), new Map([['a', 'run-1-a']]))
  assert.deepEqual(used, ['run-1-a'])
})
