import { expectedRunDate, isRunDue, runDateUtc, scheduleState, assertRunHour } from './integrity-schedule'

const at = (iso: string) => new Date(iso)

describe('integrity schedule', () => {
  it('uses the UTC calendar date', () => {
    expect(runDateUtc(at('2026-10-18T23:59:59Z'))).toBe('2026-10-18')
    expect(runDateUtc(at('2026-10-19T00:00:00Z'))).toBe('2026-10-19')
  })

  it('is due from the scheduled hour until a run exists, and a missed night is caught up', () => {
    expect(isRunDue(at('2026-10-18T00:59:59Z'), 1, false)).toBe(false)
    expect(isRunDue(at('2026-10-18T01:00:00Z'), 1, false)).toBe(true)
    expect(isRunDue(at('2026-10-18T17:00:00Z'), 1, false)).toBe(true) // service was down at 01:00: runs as soon as it is back
    expect(isRunDue(at('2026-10-18T01:05:00Z'), 1, true)).toBe(false)  // already done today
  })

  it('expects yesterday until the grace period after tonight\'s slot has passed', () => {
    expect(expectedRunDate(at('2026-10-18T03:59:59Z'), 1, 3)).toBe('2026-10-17')
    expect(expectedRunDate(at('2026-10-18T04:00:00Z'), 1, 3)).toBe('2026-10-18')
    expect(expectedRunDate(at('2026-10-01T00:30:00Z'), 1, 3)).toBe('2026-09-30') // month boundary
  })

  it('reports never run, ok and overdue', () => {
    expect(scheduleState(at('2026-10-18T12:00:00Z'), 1, null)).toBe('NEVER_RUN')
    expect(scheduleState(at('2026-10-18T12:00:00Z'), 1, '2026-10-18')).toBe('OK')
    expect(scheduleState(at('2026-10-18T12:00:00Z'), 1, '2026-10-17')).toBe('OVERDUE')
    expect(scheduleState(at('2026-10-18T02:00:00Z'), 1, '2026-10-17')).toBe('OK') // tonight's run is not late yet
    expect(scheduleState(at('2026-10-18T05:00:00Z'), 1, '2026-10-16')).toBe('OVERDUE')
  })

  it('accepts only a whole hour from 0 to 23', () => {
    expect(assertRunHour(0)).toBe(0)
    expect(assertRunHour(23)).toBe(23)
    for (const bad of [-1, 24, 1.5, NaN]) expect(() => assertRunHour(bad)).toThrow()
  })
})
