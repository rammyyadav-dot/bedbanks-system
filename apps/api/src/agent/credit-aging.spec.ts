import { ageAccount, type AgingEntry } from './credit-aging'

const now = new Date('2026-10-31T12:00:00.000Z')
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000)
const debit = (amount: bigint, daysAgo: number, booking = 'b'): AgingEntry => ({ type: 'DEBIT', amountMinor: -amount, reference: `booking:${booking}`, at: at(daysAgo) })
const credit = (amount: bigint, daysAgo: number): AgingEntry => ({ type: 'CREDIT', amountMinor: amount, reference: 'funding:r', at: at(daysAgo) })
const refund = (amount: bigint, daysAgo: number, booking: string): AgingEntry => ({ type: 'REFUND', amountMinor: amount, reference: `booking:${booking}`, at: at(daysAgo) })

describe('ageAccount (ADR 0028 slice 4, FIFO)', () => {
  it('an empty or fully prepaid account is CURRENT', () => {
    expect(ageAccount([], now)).toEqual({ state: 'CURRENT', unpaidMinor: 0n, oldestUnpaidAt: null, daysOverdue: 0 })
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
})
