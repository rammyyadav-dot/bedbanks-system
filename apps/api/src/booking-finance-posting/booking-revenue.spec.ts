import { BadRequestException } from '@nestjs/common'
import { revenueWindow } from './booking-revenue.service'
import { refundsOf, salesOf, type LedgerLeg } from './posting-plan'

const NOW = new Date('2026-10-21T15:30:00.000Z')
const leg = (type: LedgerLeg['type'], amountMinor: bigint): LedgerLeg => ({ type, amountMinor, reference: 'booking:b', idempotencyKey: `k-${type}-${amountMinor}` })

describe('revenue report window and amounts (ADR 0076)', () => {
  it('defaults to the current UTC month to date, inclusive of today', () => {
    expect(revenueWindow({}, NOW)).toEqual({ from: '2026-10-01', to: '2026-10-21', start: new Date('2026-10-01T00:00:00.000Z'), end: new Date('2026-10-22T00:00:00.000Z') })
  })
  it('is inclusive of both dates: the end instant is the start of the day after', () => {
    const w = revenueWindow({ from: '2026-01-31', to: '2026-01-31' }, NOW)
    expect(w.end.getTime() - w.start.getTime()).toBe(86_400_000)
  })
  it('accepts exactly 366 days and refuses 367', () => {
    expect(() => revenueWindow({ from: '2025-10-21', to: '2026-10-21' }, NOW)).not.toThrow()
    expect(() => revenueWindow({ from: '2025-10-20', to: '2026-10-21' }, NOW)).toThrow(BadRequestException)
  })
  it('refuses malformed, impossible and reversed dates, and arrays', () => {
    for (const q of [{ from: '2026-1-1' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-05', to: '2026-10-04' }, { from: ['2026-10-01'] }, { to: 20261001 }]) expect(() => revenueWindow(q as never, NOW)).toThrow(BadRequestException)
  })
  it('sales are the DEBIT legs and refunds the REFUND legs; a hold and its release are neither', () => {
    const legs = [leg('HOLD', -100_000n), leg('RELEASE', 100_000n), leg('DEBIT', -100_000n), leg('REFUND', 80_000n)]
    expect(salesOf(legs)).toBe(100_000n)
    expect(refundsOf(legs)).toBe(80_000n)
    expect(salesOf([])).toBe(0n)
  })
})
