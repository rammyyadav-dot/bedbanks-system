import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dialogTabTarget } from './dialog-key'
import { clearAllDrafts, clearDraft, draftKey, readDraft, writeDraft } from './draft-store'
import { mergeDraft } from './merge-draft'
import { windowRange } from './window-range'

const base = { a: 'one', b: 'two', c: 'three' }

test('mergeDraft keeps the operator edit and takes untouched fields from the newer copy', () => {
  const { merged, conflicts } = mergeDraft(base, { a: 'mine', b: 'two', c: 'three' }, { a: 'one', b: 'theirs', c: 'three' })
  assert.deepEqual(merged, { a: 'mine', b: 'theirs', c: 'three' })
  assert.deepEqual(conflicts, [])
})

test('mergeDraft reports a field both sides changed', () => {
  const { merged, conflicts } = mergeDraft(base, { a: 'mine', b: 'two', c: 'three' }, { a: 'theirs', b: 'two', c: 'three' })
  assert.equal(merged.a, 'mine')
  assert.deepEqual(conflicts, ['a'])
})

test('windowRange returns the rows that intersect the scrollport plus overscan', () => {
  const range = windowRange({ count: 100, rowHeight: 10, viewport: 50, scrollTop: 200, overscan: 1 })
  assert.deepEqual(range, { start: 19, end: 26, padTop: 190, padBottom: 740 })
})

test('windowRange shows the whole list when there is nothing to clip', () => {
  assert.deepEqual(windowRange({ count: 4, rowHeight: 20, viewport: 0, scrollTop: 0 }), { start: 0, end: 4, padTop: 0, padBottom: 0 })
})

test('dialogTabTarget wraps only at the ends of the dialog', () => {
  assert.equal(dialogTabTarget(false, 2, 3), 0)
  assert.equal(dialogTabTarget(true, 0, 3), 2)
  assert.equal(dialogTabTarget(false, 1, 3), null)
  assert.equal(dialogTabTarget(false, -1, 3), null)
})

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size }, key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) }, removeItem: (k: string) => { map.delete(k) },
  }
}

test('draft storage round-trips a valid draft and drops a corrupt one', () => {
  const store = fakeStorage()
  const key = draftKey('quotation', 'tenant-1')
  const isPair = (v: unknown): v is { a: string } => !!v && typeof v === 'object' && typeof (v as { a?: unknown }).a === 'string'
  writeDraft(store, key, { base: { a: '1' }, value: { a: '2' }, savedAt: '2026-01-01T00:00:00.000Z' })
  assert.deepEqual(readDraft(store, key, isPair), { base: { a: '1' }, value: { a: '2' }, savedAt: '2026-01-01T00:00:00.000Z' })
  store.setItem(key, '{')
  assert.equal(readDraft(store, key, isPair), null)
  writeDraft(store, key, { base: { a: '1' }, value: { a: '2' }, savedAt: '2026-01-01T00:00:00.000Z' })
  clearDraft(store, key)
  assert.equal(readDraft(store, key, isPair), null)
  writeDraft(store, draftKey('other', 'x'), { base: { a: '1' }, value: { a: '9' }, savedAt: '2026-01-01T00:00:00.000Z' })
  clearAllDrafts(store)
  assert.equal(store.length, 0)
})
