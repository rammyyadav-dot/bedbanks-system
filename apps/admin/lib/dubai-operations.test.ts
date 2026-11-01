import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSevenDayRates,
  buildSevenDayAvailability,
  sellabilityMessage,
  buildCancellationPolicyWrite,
  buildCancellationSimulationPayload,
} from './dubai-operations'

const plan = { id: 'rp-dubai-flex', occupancy: 2, currency: 'AED', minStay: 1 }

test('Dubai Admin 7-day Rate Loader builds exact authoritative SELL and NET payloads', () => {
  const sell = buildSevenDayRates(plan, '2026-10-20', '299.00', 'SELL')
  assert.equal(sell.length, 7)
  assert.deepEqual(sell.map(row => row.stayDate), ['2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26'])
  assert.ok(sell.every(row => row.ratePlanId === plan.id && row.occupancy === 2 && row.currency === 'AED' && row.amountMinor === '29900' && row.amountBasis === 'SELL'))
  const net = buildSevenDayRates(plan, '2026-10-20', '275.50', 'NET')
  assert.ok(net.every(row => row.amountMinor === '27550' && row.amountBasis === 'NET'))
  assert.ok(buildSevenDayRates(plan, '2026-10-20', '0.10', 'SELL').every(row => row.amountMinor === '10'))
})

test('Dubai Admin Inventory loader builds seven open rows and Stop Sell/Reopen payloads', () => {
  const open = buildSevenDayAvailability(plan, '2026-10-20', '5', false)
  assert.equal(open.length, 7)
  assert.ok(open.every(row => row.allotment === 5 && !('sold' in row) && row.stopSell === false && row.minStay === 1))
  const stopped = buildSevenDayAvailability(plan, '2026-10-20', '5', true)
  assert.ok(stopped.every(row => row.stopSell === true))
  const reopened = buildSevenDayAvailability(plan, '2026-10-20', '5', false)
  assert.ok(reopened.every(row => row.stopSell === false))
})

test('Dubai Admin rejects invalid operator amounts and allotments before API writes', () => {
  assert.throws(() => buildSevenDayRates(plan, '2026-10-20', '-1', 'SELL'), /Invalid amount/)
  assert.throws(() => buildSevenDayRates(plan, 'bad-date', '299', 'SELL'), /Invalid start date/)
  assert.throws(() => buildSevenDayRates(plan, '2026-10-20', '1.001', 'SELL'), /Invalid amount/)
  assert.throws(() => buildSevenDayRates(plan, '2026-10-20', 'abc', 'SELL'), /Invalid amount/)
  assert.throws(() => buildSevenDayAvailability(plan, '2026-10-20', '1.5', false), /Invalid allotment/)
  assert.throws(() => buildSevenDayAvailability(plan, '2026-10-20', '-1', false), /Invalid allotment/)
})

test('Dubai Admin exposes visible sellability outcome and reasons', () => {
  assert.equal(sellabilityMessage({ eligible: true, status: 'ELIGIBLE_FOR_FUTURE_SEARCH', reasons: [] }), 'Sellable: ELIGIBLE_FOR_FUTURE_SEARCH')
  assert.equal(sellabilityMessage({ eligible: false, status: 'NOT_SELLABLE', reasons: ['STOP_SELL', 'NO_INVENTORY'] }), 'Not sellable: STOP_SELL, NO_INVENTORY')
})

test('Admin Cancellation Policy builder and simulator convert operator inputs to integer minor units', () => {
  assert.deepEqual(
    buildCancellationPolicyWrite({ daysBeforeCheckinValue: '7', mode: 'PERCENTAGE', penaltyValue: '50', currency: 'aed' }),
    { daysBeforeCheckin: 7, penaltyPercent: 50, currency: 'AED' },
  )
  assert.deepEqual(
    buildCancellationPolicyWrite({ daysBeforeCheckinValue: '3', mode: 'FIXED', penaltyValue: '150.25', currency: 'AED' }),
    { daysBeforeCheckin: 3, penaltyMinor: '15025', currency: 'AED' },
  )
  assert.throws(() => buildCancellationPolicyWrite({ daysBeforeCheckinValue: '-1', mode: 'PERCENTAGE', penaltyValue: '50', currency: 'AED' }), /Invalid days/)
  assert.throws(() => buildCancellationPolicyWrite({ daysBeforeCheckinValue: '3', mode: 'PERCENTAGE', penaltyValue: '120', currency: 'AED' }), /Invalid penalty percent/)

  const sim = buildCancellationSimulationPayload({
    checkIn: '2026-12-31',
    requestedAt: '2026-12-28T12:00:00Z',
    currency: 'AED',
    cancellableAmountMajor: '950.00',
    nightlyAmountsMajorCsv: '250.00, 300.00, 400.00',
    customerAmountPaidMajor: '950.00',
    retainedFeesMajor: '25.00',
    priorRefundsMajor: '0.00',
    policyType: 'REFUNDABLE',
    deadlineSemantics: 'CALENDAR_DAYS_AT_LOCAL_TIME',
    propertyTimeZone: 'Asia/Dubai',
    checkInLocalTime: '15:00',
  })
  assert.equal(sim.cancellableAmountMinor, '95000')
  assert.deepEqual(sim.nightlyAmountsMinor, ['25000', '30000', '40000'])
  assert.equal(sim.retainedFeesMinor, '2500')
})
