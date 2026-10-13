import test from 'node:test'
import assert from 'node:assert/strict'
import { blankLine, buildGuestPricesInput, draftFromLines, type GuestLineDraft } from './guest-prices'

const v = '2026-10-12T08:00:00.000Z'
const child = (minAge: string, maxAge: string, amount: string, basis: GuestLineDraft['basis'] = 'SELL'): GuestLineDraft => ({ kind: 'CHILD', minAge, maxAge, amount, basis })

test('lines become integer minor units with the plan version, and an extra adult needs no ages', () => {
  const r = buildGuestPricesInput([child('0', '2', '0'), child('3', '11', '150.5'), { kind: 'EXTRA_ADULT', minAge: '', maxAge: '', amount: '300', basis: 'SELL' }], 'AED', v)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.input, { expectedUpdatedAt: v, lines: [
    { kind: 'CHILD', minAge: 0, maxAge: 2, amountMinor: '0', amountBasis: 'SELL', currency: 'AED' },
    { kind: 'CHILD', minAge: 3, maxAge: 11, amountMinor: '15050', amountBasis: 'SELL', currency: 'AED' },
    { kind: 'EXTRA_ADULT', amountMinor: '30000', amountBasis: 'SELL', currency: 'AED' },
  ] })
})
test('zero is an explicit free guest, but an empty amount is not: it is a missing price', () => {
  assert.equal(buildGuestPricesInput([child('0', '2', '0')], 'AED', v).input?.lines[0]?.amountMinor, '0')
  assert.match(buildGuestPricesInput([child('0', '2', '')], 'AED', v).problems[0]!, /plain AED amount/)
})
test('the basis is never assumed', () => {
  assert.match(buildGuestPricesInput([child('0', '2', '10', '')], 'AED', v).problems[0]!, /choose NET or SELL/)
})
test('bad amounts, bad ages, overlapping bands and a second extra-adult line are reported together and nothing is sent', () => {
  const r = buildGuestPricesInput([child('0', '5', '1,000'), child('5', '8', '10'), child('9', '20', '10'), { ...blankLine('EXTRA_ADULT'), amount: '1', basis: 'SELL' }, { ...blankLine('EXTRA_ADULT'), amount: '2', basis: 'SELL' }], 'AED', v)
  assert.equal(r.input, null)
  assert.ok(r.problems.some((p) => /plain AED amount/.test(p)))
  assert.ok(r.problems.some((p) => /whole ages from 0 to 17/.test(p)))
  assert.ok(r.problems.some((p) => /overlap/.test(p)))
  assert.ok(r.problems.some((p) => /Only one extra-adult/.test(p)))
})
test('stored lines load back as editable major-unit text', () => {
  const drafts = draftFromLines([{ kind: 'CHILD', minAge: 3, maxAge: 11, amountMinor: '15050', amountBasis: 'NET', currency: 'AED' }, { kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99, amountMinor: '30000', amountBasis: 'SELL', currency: 'AED' }])
  assert.deepEqual(drafts, [child('3', '11', '150.50', 'NET'), { kind: 'EXTRA_ADULT', minAge: '', maxAge: '', amount: '300.00', basis: 'SELL' }])
})
