import test from 'node:test'
import assert from 'node:assert/strict'
import { basisPointsToPercent, blankPromotion, buildPromotionsInput, draftFromPromotions, percentToBasisPoints } from './promotions'

const v = '2026-10-12T08:00:00.000Z'

test('percent text becomes integer basis points without floating point', () => {
  assert.equal(percentToBasisPoints('10'), 1000)
  assert.equal(percentToBasisPoints('12.5'), 1250)
  assert.equal(percentToBasisPoints('0.07'), 7)
  assert.equal(percentToBasisPoints('12.345'), null)
  assert.equal(percentToBasisPoints('-5'), null)
  assert.equal(percentToBasisPoints('ten'), null)
  assert.equal(basisPointsToPercent(1250), '12.5')
  assert.equal(basisPointsToPercent(1000), '10')
  assert.equal(basisPointsToPercent(7), '0.07')
})

test('an early bird and a free-nights promotion build the API input', () => {
  const r = buildPromotionsInput([
    { ...blankPromotion('EARLY_BIRD'), name: ' Book early ', percent: '12.5', minLeadDays: '30', stayFrom: '2027-01-01' },
    { ...blankPromotion('FREE_NIGHTS'), name: 'Stay 4 pay 3', minNights: '4', freeNights: '1' },
  ], v)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.input?.promotions[0], { kind: 'EARLY_BIRD', name: 'Book early', percentBp: 1250, minLeadDays: 30, maxLeadDays: null, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: '2027-01-01', stayTo: null, combinable: false, stayWindowMode: 'WHOLE_STAY', discountBase: 'ROOM_AND_GUESTS' })
  assert.deepEqual(r.input?.promotions[1], { kind: 'FREE_NIGHTS', name: 'Stay 4 pay 3', percentBp: null, minLeadDays: null, maxLeadDays: null, minNights: 4, freeNights: 1, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, combinable: false, stayWindowMode: 'WHOLE_STAY', discountBase: 'ROOM_AND_GUESTS' })
  assert.equal(r.input?.expectedUpdatedAt, v)
})

test('obvious mistakes are reported together and nothing is built', () => {
  const r = buildPromotionsInput([
    { ...blankPromotion('EARLY_BIRD'), name: 'A', percent: '95', minLeadDays: '0' },
    { ...blankPromotion('FREE_NIGHTS'), name: 'a', minNights: '3', freeNights: '3' },
    { ...blankPromotion('LONG_STAY'), name: '', percent: '10', minNights: '1', bookFrom: '2027-02-30' },
  ], v)
  assert.equal(r.input, null)
  assert.ok(r.problems.length >= 6)
  assert.ok(r.problems.some((p) => p.includes('used twice')))
  assert.ok(r.problems.some((p) => p.includes('real date')))
})

test('stored promotions round-trip through the editor', () => {
  const rows = [{ kind: 'LAST_MINUTE' as const, name: 'Late deal', percentBp: 1500, minLeadDays: null, maxLeadDays: 3, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, combinable: false, stayWindowMode: 'WHOLE_STAY' as const, discountBase: 'ROOM_AND_GUESTS' as const }]
  const drafts = draftFromPromotions(rows)
  assert.equal(drafts[0]!.percent, '15')
  assert.deepEqual(buildPromotionsInput(drafts, v).input?.promotions, rows)
})

test('combinable, nights-in-window and room-only round-trip; a partial window needs a stay window (ADR 0067, F-09)', () => {
  const rows = [{ kind: 'LONG_STAY' as const, name: 'Summer', percentBp: 1000, minLeadDays: null, maxLeadDays: null, minNights: 3, freeNights: null, bookFrom: null, bookTo: null, stayFrom: '2027-06-01', stayTo: '2027-08-31', combinable: true, stayWindowMode: 'NIGHTS_IN_WINDOW' as const, discountBase: 'ROOM_ONLY' as const }]
  assert.deepEqual(buildPromotionsInput(draftFromPromotions(rows), v).input?.promotions, rows)
  const open = draftFromPromotions([{ ...rows[0]!, stayFrom: null, stayTo: null }])
  assert.ok(buildPromotionsInput(open, v).problems.some((p) => p.includes('needs a stay window')))
})
