import { ageAccount, type AgingEntry } from './credit-aging'

const now = new Date('2026-10-31T12:00:00.000Z')
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000)
const debit = (amount: bigint, daysAgo: number, booking = 'b'): AgingEntry => ({ type: 'DEBIT', amountMinor: -amount, reference: `booking:${booking}`, at: at(daysAgo) })
const credit = (amount: bigint, daysAgo: number): AgingEntry => ({ type: 'CREDIT', amountMinor: amount, reference: 'funding:r', at: at(daysAgo) })
const refund = (amount: bigint, daysAgo: number, booking: string): AgingEntry => ({ type: 'REFUND', amountMinor: amount, reference: `booking:${booking}`, at: at(daysAgo) })

describe('ageAccount with adjustments and reversals (ADR 0100)', () => {
  const reversal = (amount: bigint, daysAgo: number): AgingEntry => ({ type: 'REVERSAL', amountMinor: -amount, reference: 'funding:r', at: at(daysAgo) })
  const adjustment = (signed: bigint, daysAgo: number): AgingEntry => ({ type: 'ADJUSTMENT', amountMinor: signed, reference: 'adjustment:a', at: at(daysAgo) })
  it('a recalled payment makes the money owed again, dated when it was taken back', () => {
    const paid = [debit(100n, 40), credit(100n, 20)]
    expect(ageAccount(paid, now).state).toBe('CURRENT')
    expect(ageAccount([...paid, reversal(100n, 8)], now)).toMatchObject({ state: 'NOTICE', unpaidMinor: 100n, daysOverdue: 8 })
  })
  it('a recall of prepaid money that was never spent leaves nothing owed', () => {
    expect(ageAccount([credit(100n, 20), reversal(100n, 8)], now)).toMatchObject({ state: 'CURRENT', unpaidMinor: 0n })
  })
  it('a credit adjustment pays the oldest charge and a debit adjustment is a new charge', () => {
    expect(ageAccount([debit(100n, 40), adjustment(100n, 1)], now)).toMatchObject({ state: 'CURRENT', unpaidMinor: 0n })
    expect(ageAccount([adjustment(-100n, 9)], now)).toMatchObject({ state: 'NOTICE', unpaidMinor: 100n, daysOverdue: 9 })
  })
})

describe('ageAccount (ADR 0028 slice 4, FIFO)', () => {
  it('an empty or fully prepaid account is CURRENT', () => {
    expect(ageAccount([], now)).toEqual({ state: 'CURRENT', unpaidMinor: 0n, overdueUnpaidMinor: 0n, oldestUnpaidAt: null, daysOverdue: 0 })
    expect(ageAccount([credit(1000n, 40), debit(1000n, 35)], now).state).toBe('CURRENT')
  })
  it('notice from 7 whole days, holds refused from 30', () => {
    expect(ageAccount([debit(100n, 6)], now)).toMatchObject({ state: 'CURRENT', daysOverdue: 6 })
    expect(ageAccount([debit(100n, 7)], now)).toMatchObject({ state: 'NOTICE', daysOverdue: 7 })
    expect(ageAccount([debit(100n, 29)], now).state).toBe('NOTICE')
    expect(ageAccount([debit(100n, 30)], now)).toMatchObject({ state: 'HOLDS_REFUSED', unpaidMinor: 100n })
  })
  it('a payment settles the oldest charge first; partial payment leaves the oldest open', () => {
    const r = ageAccount([debit(100n, 40, 'old'), debit(100n, 3, 'new'), credit(100n, 1)], now)
    expect(r).toMatchObject({ state: 'CURRENT', unpaidMinor: 100n, daysOverdue: 3 })
    expect(ageAccount([debit(100n, 40), credit(60n, 1)], now)).toMatchObject({ state: 'HOLDS_REFUSED', unpaidMinor: 40n })
  })
  it('a refund pays its own booking first, not the oldest charge', () => {
    const r = ageAccount([debit(100n, 40, 'old'), debit(100n, 3, 'cancelled'), refund(100n, 2, 'cancelled')], now)
    expect(r).toMatchObject({ state: 'HOLDS_REFUSED', unpaidMinor: 100n, daysOverdue: 40 })
  })
  it('holds and releases are pending, not charges', () => {
    expect(ageAccount([{ type: 'HOLD', amountMinor: -100n, reference: 'booking:x', at: at(50) }], now).state).toBe('CURRENT')
  })
  it('splits out the unpaid amount that is at least 7 days old (the credit risk amount rule)', () => {
    const a = ageAccount([debit(1000n, 10), debit(400n, 7), debit(250n, 6), debit(50n, 1)], now)
    expect([a.unpaidMinor, a.overdueUnpaidMinor]).toEqual([1700n, 1400n])
    expect(ageAccount([debit(1000n, 10), credit(1000n, 2)], now).overdueUnpaidMinor).toBe(0n)
  })
})
