import test from 'node:test'
import assert from 'node:assert/strict'
import { HOTEL_VIEWS_KEY, deleteHotelView, loadHotelViews, saveHotelView, type ViewStorage } from './hotel-views'

const memory = (initial?: string): ViewStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>(initial === undefined ? [] : [[HOTEL_VIEWS_KEY, initial]])
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

test('saved hotel views keep only known filter keys and reject empty input', () => {
  const s = memory()
  assert.deepEqual(saveHotelView(s, ' ', { readiness: 'BLOCKED' }), { ok: false, reason: 'A name is required.' })
  assert.equal(saveHotelView(s, 'Blocked', {}).ok, false)
  const r = saveHotelView(s, 'Blocked', { readiness: 'BLOCKED', tenantId: 'other', bogus: 'x' } as never)
  assert.ok(r.ok)
  assert.deepEqual(loadHotelViews(s), [{ name: 'Blocked', filters: { readiness: 'BLOCKED' } }])
})

test('saving under an existing name replaces it; delete removes it', () => {
  const s = memory()
  saveHotelView(s, 'A', { readiness: 'READY' }); saveHotelView(s, 'A', { readiness: 'PARTIAL' })
  assert.deepEqual(loadHotelViews(s), [{ name: 'A', filters: { readiness: 'PARTIAL' } }])
  deleteHotelView(s, 'A')
  assert.deepEqual(loadHotelViews(s), [])
})

test('corrupt or unavailable storage yields no views and a clear refusal', () => {
  assert.deepEqual(loadHotelViews(memory('not json')), [])
  assert.deepEqual(loadHotelViews(memory('{"a":1}')), [])
  assert.deepEqual(loadHotelViews(null), [])
  assert.equal(saveHotelView(null, 'A', { readiness: 'READY' }).ok, false)
  const throwing: ViewStorage = { getItem: () => null, setItem: () => { throw new Error('quota') } }
  assert.equal(saveHotelView(throwing, 'A', { readiness: 'READY' }).ok, false)
})

test('the view list is capped', () => {
  const s = memory()
  for (let i = 0; i < 20; i++) assert.ok(saveHotelView(s, `v${i}`, { readiness: 'READY' }).ok)
  assert.equal(saveHotelView(s, 'extra', { readiness: 'READY' }).ok, false)
})
