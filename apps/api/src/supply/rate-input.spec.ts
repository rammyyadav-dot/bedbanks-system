import { BadRequestException } from '@nestjs/common'
import { availabilityInput, calendarDate, inputRows, positiveMinor, rateInput, uniqueRows } from './rate-input'

describe('rate calendar boundary validation', () => {
  it.each(['2030-02-29', '2030-02-31', '2030-13-01', '2030-1-01', '', null, '2030-01-01T00:00:00Z'])('refuses invalid calendar date %p', value => {
    expect(() => calendarDate(value)).toThrow(BadRequestException)
  })
  it('accepts leap day and preserves the requested calendar day', () => expect(calendarDate('2032-02-29').toISOString()).toBe('2032-02-29T00:00:00.000Z'))
  it.each(['1.5', '1e3', '', ' ', '0x10', '-1', '0', '9223372036854775808', NaN, Infinity, 9007199254740992, null, {}])('refuses invalid amount %p with a client error', value => {
    expect(() => positiveMinor(value)).toThrow(BadRequestException)
  })
  it('preserves bigint precision', () => expect(positiveMinor('9223372036854775807')).toBe(9223372036854775807n))
  it.each([{ sold: 1 }, { held: 0 }, { stopSell: 'false' }, { minStay: 0 }, { allotment: -1 }])('protects inventory controls %p', override => {
    expect(() => availabilityInput({ ratePlanId: 'p', stayDate: '2030-01-01', allotment: 2, ...override })).toThrow(BadRequestException)
  })
  it('preserves omitted stop-sell and minimum stay rather than clearing them', () => {
    const row = availabilityInput({ ratePlanId: 'p', stayDate: '2030-01-01', allotment: 2 })
    expect(row.stopSell).toBeUndefined(); expect(row.minStay).toBeUndefined()
  })
  it('refuses ambiguous duplicate cells', () => {
    expect(() => uniqueRows([{ ratePlanId: 'p', stayDate: calendarDate('2030-01-01'), occupancy: 2 }, { ratePlanId: 'p', stayDate: calendarDate('2030-01-01'), occupancy: 2 }])).toThrow(BadRequestException)
  })
  it.each([[], [null], new Array(367).fill({}), 'rows'])('bounds batch input %p', rows => expect(() => inputRows(rows, 'rate')).toThrow(BadRequestException))
  it('refuses an invalid expected version', () => expect(() => rateInput({ ratePlanId: 'p', stayDate: '2030-01-01', occupancy: 2, amountMinor: '100', amountBasis: 'SELL', currency: 'AED', expectedUpdatedAt: 'yesterday' })).toThrow(BadRequestException))
})
