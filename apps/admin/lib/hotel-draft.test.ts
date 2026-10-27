import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOTEL_PROFILE_STATUSES } from '@bedbanks/contracts'
import { allowedStatusTargets, mergeDraft } from './hotel-setup-ui'
import { clearAllDrafts, clearDraft, draftKey, readDraft, writeDraft } from './draft-store'

test('lifecycle targets: one list, never the current status, never COMPLETE, ARCHIVED only restores to DRAFT', () => {
  assert.deepEqual(allowedStatusTargets('DRAFT'), ['INCOMPLETE', 'SUSPENDED', 'ARCHIVED'])
  assert.deepEqual(allowedStatusTargets('INCOMPLETE'), ['DRAFT', 'SUSPENDED', 'ARCHIVED'])
  assert.deepEqual(allowedStatusTargets('COMPLETE'), ['DRAFT', 'INCOMPLETE', 'SUSPENDED', 'ARCHIVED'])
  assert.deepEqual(allowedStatusTargets('SUSPENDED'), ['DRAFT', 'INCOMPLETE', 'ARCHIVED'])
  assert.deepEqual(allowedStatusTargets('ARCHIVED'), ['DRAFT'])
  for (const current of HOTEL_PROFILE_STATUSES) {
    const targets = allowedStatusTargets(current)
    assert.ok(!targets.includes(current) && !targets.includes('COMPLETE'), current)
    assert.ok(targets.length > 0, `${current} must always offer a way forward`)
  }
})

const base = { a: 'one', b: 'two', c: 'three' }

test('mergeDraft: untouched fields take the newer value, edited fields keep the draft', () => {
  const { merged, conflicts } = mergeDraft(base, { a: 'mine', b: 'two', c: 'three' }, { a: 'one', b: 'theirs', c: 'three' })
  assert.deepEqual(merged, { a: 'mine', b: 'theirs', c: 'three' })
  assert.deepEqual(conflicts, [])
})

test('mergeDraft: a field both sides changed differently keeps the draft and is reported', () => {
  const { merged, conflicts } = mergeDraft(base, { a: 'mine', b: 'two', c: 'three' }, { a: 'theirs', b: 'two', c: 'three' })
  assert.equal(merged.a, 'mine')
  assert.deepEqual(conflicts, ['a'])
})

test('mergeDraft: both sides making the same change is not a conflict', () => {
  const { merged, conflicts } = mergeDraft(base, { ...base, a: 'same' }, { ...base, a: 'same' })
  assert.equal(merged.a, 'same'); assert.deepEqual(conflicts, [])
})

test('mergeDraft compares nested values by content and does not mutate its inputs', () => {
  const b = { rows: [{ x: '1' }] }; const d = { rows: [{ x: '1' }, { x: '2' }] }; const l = { rows: [{ x: '1' }] }
  const snapshot = JSON.stringify([b, d, l])
  assert.deepEqual(mergeDraft(b, d, l).merged, d)
  assert.equal(JSON.stringify([b, d, l]), snapshot)
})

test('after a save, an edit typed during the request survives and the rest adopts the stored (normalised) value', () => {
  const submitted = { a: ' padded ', b: 'two' }
  const typedDuringSave = { a: ' padded ', b: 'two + more' }
  const stored = { a: 'padded', b: 'two' }
  assert.deepEqual(mergeDraft(submitted, typedDuringSave, stored).merged, { a: 'padded', b: 'two + more' })
})

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size }, key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) }, removeItem: (k: string) => { map.delete(k) }, map,
  }
}
const isPair = (v: unknown): v is { a: string } => !!v && typeof v === 'object' && typeof (v as { a: unknown }).a === 'string'

test('draft store round-trips a valid draft, scoped by editor and hotel', () => {
  const store = fakeStorage()
  const key = draftKey('policies', 'hotel-1')
  assert.notEqual(key, draftKey('policies', 'hotel-2')); assert.notEqual(key, draftKey('setup', 'hotel-1'))
  writeDraft(store, key, { base: { a: '1' }, value: { a: '2' }, savedAt: '2026-01-01T00:00:00.000Z' })
  assert.deepEqual(readDraft(store, key, isPair), { base: { a: '1' }, value: { a: '2' }, savedAt: '2026-01-01T00:00:00.000Z' })
  clearDraft(store, key)
  assert.equal(readDraft(store, key, isPair), null)
})

test('a corrupt or wrongly shaped stored draft is dropped, never applied', () => {
  const key = draftKey('setup', 'h')
  for (const raw of ['{not json', '{"base":1,"value":2,"savedAt":"x"}', '{"base":{"a":"1"},"value":{"a":2},"savedAt":"x"}', 'null', '[]']) {
    const store = fakeStorage({ [key]: raw })
    assert.equal(readDraft(store, key, isPair), null, raw)
  }
})

test('unavailable or throwing storage degrades to "no draft" instead of failing the editor', () => {
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('denied') } }
  assert.equal(readDraft(broken, 'k', isPair), null)
  assert.doesNotThrow(() => writeDraft(broken, 'k', { base: { a: '' }, value: { a: '' }, savedAt: 'x' }))
  assert.doesNotThrow(() => clearDraft(broken, 'k'))
  assert.equal(readDraft(null, 'k', isPair), null)
})

test('sign-out clears every hotel draft and nothing else', () => {
  const store = fakeStorage({ [draftKey('setup', 'h1')]: '{}', [draftKey('policies', 'h2')]: '{}', 'unrelated': 'keep' })
  clearAllDrafts(store)
  assert.deepEqual([...store.map.keys()], ['unrelated'])
})
