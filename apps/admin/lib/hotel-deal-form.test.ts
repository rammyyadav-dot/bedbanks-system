import test from 'node:test'
import assert from 'node:assert/strict'
import { issueMessages, blankDraft, buildCreateInput, buildReplaceInput, buildTerms, describeTerms, draftFromTerms, type DealDraft } from './hotel-deal-form'

const base = (over: Partial<DealDraft> = {}): DealDraft => ({ ...blankDraft(), code: 'SUMMER26', name: 'Summer special', percent: '10', ratePlanIds: ['rp1'], ...over })

test('a percent deal becomes integer basis points and omits what it does not use', () => {
  const r = buildCreateInput(base({ percent: '12.5' }), 'h1', 'idem-key-0001')
  assert.deepEqual(r.problems, [])
  assert.equal(r.input?.percentBp, 1250)
  assert.equal(r.input?.hotelId, 'h1')
  assert.equal(r.input?.idempotencyKey, 'idem-key-0001')
  assert.ok(!('amountMinor' in (r.input ?? {})) && !('freeNights' in (r.input ?? {})) && !('fromNight' in (r.input ?? {})))
})

test('a fixed amount is sent as a minor-unit string in the deal currency, never a number', () => {
  const r = buildTerms(base({ kind: 'FIXED_OFF', percent: '', amount: '25.50', amountScope: 'PER_STAY' }))
  assert.equal(r.terms?.amountMinor, '2550')
  assert.equal(r.terms?.currency, 'AED')
  assert.equal(r.terms?.amountScope, 'PER_STAY')
  assert.equal(r.terms?.percentBp, null)
  assert.ok(buildTerms(base({ kind: 'FIXED_OFF', percent: '', amount: '25.555' })).problems.length > 0)
  assert.ok(buildTerms(base({ kind: 'FIXED_OFF', percent: '', amount: '0' })).problems.length > 0)
  assert.ok(buildTerms(base({ kind: 'FIXED_OFF', percent: '', amount: '-5' })).problems.length > 0)
})

test('stay X pay Y sends the stay and the free nights', () => {
  const r = buildTerms(base({ kind: 'STAY_X_PAY_Y', percent: '', minNights: '7', payNights: '6' }))
  assert.deepEqual([r.terms?.minNights, r.terms?.freeNights], [7, 1])
  assert.ok(buildTerms(base({ kind: 'STAY_X_PAY_Y', percent: '', minNights: '3', payNights: '3' })).problems.length > 0)
  assert.ok(buildTerms(base({ kind: 'STAY_X_PAY_Y', percent: '', minNights: '3', payNights: '0' })).problems.length > 0)
})

test('every Nth night free, subsequent nights, early bird and flash sale each need their own parameter', () => {
  assert.equal(buildTerms(base({ kind: 'EVERY_NTH_FREE', percent: '', minNights: '4' })).terms?.minNights, 4)
  assert.ok(buildTerms(base({ kind: 'EVERY_NTH_FREE', percent: '', minNights: '1' })).problems.length > 0)
  assert.equal(buildTerms(base({ kind: 'SUBSEQUENT_NIGHTS', fromNight: '3' })).terms?.fromNight, 3)
  assert.ok(buildTerms(base({ kind: 'SUBSEQUENT_NIGHTS', fromNight: '1' })).problems.length > 0)
  assert.equal(buildTerms(base({ kind: 'EARLY_BIRD', minLeadDays: '30' })).terms?.minLeadDays, 30)
  assert.ok(buildTerms(base({ kind: 'EARLY_BIRD', minLeadDays: '' })).problems.length > 0)
  assert.ok(buildTerms(base({ kind: 'FLASH_SALE', bookFrom: '2026-10-01' })).problems.some((p) => p.includes('flash sale')))
  assert.ok(buildTerms(base({ kind: 'FLASH_SALE', bookFrom: '2026-10-01', bookTo: '2026-10-05' })).terms)
})

test('fields of another kind are never sent: changing the kind cannot leave a stale value behind', () => {
  const r = buildTerms(base({ kind: 'EVERY_NTH_FREE', percent: '15', minNights: '3', fromNight: '4', minLeadDays: '9', amount: '10' }))
  assert.equal(r.terms?.percentBp, null)
  assert.equal(r.terms?.fromNight, null)
  assert.equal(r.terms?.minLeadDays, null)
  assert.equal(r.terms?.amountMinor, null)
})

test('a discount above 50% needs a sell floor, and out-of-range values are refused together', () => {
  assert.ok(buildTerms(base({ percent: '60' })).problems.some((p) => p.includes('sell floor')))
  assert.ok(buildTerms(base({ percent: '60', minSellFloor: '300' })).terms)
  const r = buildTerms(base({ percent: '95', code: '!', name: '', priority: '500', ratePlanIds: [], sourceMarkets: 'india', activeFrom: '2026-12-01', activeTo: '2026-11-01' }))
  assert.equal(r.terms, null)
  assert.ok(r.problems.length >= 6)
})

test('audience lists and weekdays are normalized', () => {
  const r = buildTerms(base({ sourceMarkets: 'in, ae; gb', channels: ['PORTAL'], agencyIds: ['a1'], weekdays: [5, 4], combinable: true, stackingGroup: ' SUMMER ' }))
  assert.deepEqual(r.terms?.sourceMarkets, ['IN', 'AE', 'GB'])
  assert.deepEqual(r.terms?.weekdays, [4, 5])
  assert.equal(r.terms?.stackingGroup, 'SUMMER')
  assert.deepEqual(r.terms?.channels, ['PORTAL'])
})

test('guards are percentages and amounts in integer units', () => {
  const r = buildTerms(base({ maxDiscountPercent: '25', minMarginPercent: '3.5', minSellFloor: '450.00' }))
  assert.deepEqual([r.terms?.maxDiscountBp, r.terms?.minMarginBp, r.terms?.minSellFloorMinor], [2500, 350, '45000'])
  assert.ok(buildTerms(base({ maxDiscountPercent: '25.123' })).problems.length > 0)
})

test('a replace input carries the version it replaces', () => {
  const r = buildReplaceInput(base(), 4)
  assert.equal(r.input?.expectedVersion, 4)
  assert.ok(!('hotelId' in (r.input ?? {})) && !('idempotencyKey' in (r.input ?? {})))
})

test('a stored deal round-trips through the form unchanged', () => {
  const draft = base({ kind: 'STAY_X_PAY_Y', percent: '', minNights: '5', payNights: '4', weekdays: [4], sourceMarkets: 'IN', channels: ['PORTAL'], minSellFloor: '100', activeFrom: '2026-11-01' })
  const built = buildTerms(draft).terms!
  const back = draftFromTerms({ ...built, priority: built.priority })
  assert.deepEqual(buildTerms(back).terms, built)
})

test('describes each kind in one line', () => {
  const t = (over: Record<string, unknown>) => describeTerms({ kind: 'PERCENT_OFF', percentBp: null, amountMinor: null, currency: null, amountScope: null, minNights: null, freeNights: null, fromNight: null, minLeadDays: null, ...over } as never)
  assert.equal(t({ percentBp: 1250 }), '12.5% off')
  assert.equal(t({ kind: 'STAY_X_PAY_Y', minNights: 3, freeNights: 1 }), 'Stay 3, pay 2')
  assert.equal(t({ kind: 'EVERY_NTH_FREE', minNights: 4 }), 'Every 4th night free')
  assert.equal(t({ kind: 'FIXED_OFF', amountMinor: '2550', currency: 'AED', amountScope: 'PER_NIGHT' }), 'AED 25.50 off per night')
  assert.equal(t({ kind: 'SUBSEQUENT_NIGHTS', percentBp: 2000, fromNight: 2 }), '20% off from night 2')
})

test('issue messages come from the API objects, falling back to plain strings', () => {
  assert.deepEqual(issueMessages({ structuredDetails: [{ code: 'A', message: 'First' }, { code: 'B', message: 'Second' }, 5, null], details: ['x'] }), ['First', 'Second'])
  assert.deepEqual(issueMessages({ structuredDetails: [], details: ['plain'] }), ['plain'])
  assert.deepEqual(issueMessages({}), [])
})
