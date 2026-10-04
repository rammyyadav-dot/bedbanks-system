import { releaseAllows, releaseDeadline, zonedLocalToUtc } from './zoned-time'

describe('zoned time and release deadline', () => {
  it('Asia/Dubai is UTC+4 with no DST', () => {
    expect(zonedLocalToUtc('2026-10-15', '18:00', 'Asia/Dubai').toISOString()).toBe('2026-10-15T14:00:00.000Z')
    expect(zonedLocalToUtc('2026-07-01', '00:00', 'Asia/Dubai').toISOString()).toBe('2026-06-30T20:00:00.000Z')
  })
  it('release boundary: before / at / after (sellable only strictly before)', () => {
    // checkIn 2026-10-15, 3 days, 18:00 Dubai => 2026-10-12 18:00 +04 = 14:00Z
    const deadline = releaseDeadline('2026-10-15', 3, '18:00', 'Asia/Dubai')
    expect(deadline.toISOString()).toBe('2026-10-12T14:00:00.000Z')
    expect(releaseAllows(new Date(deadline.getTime() - 1), '2026-10-15', 3, '18:00', 'Asia/Dubai')).toBe(true)
    expect(releaseAllows(deadline, '2026-10-15', 3, '18:00', 'Asia/Dubai')).toBe(false)
    expect(releaseAllows(new Date(deadline.getTime() + 1), '2026-10-15', 3, '18:00', 'Asia/Dubai')).toBe(false)
  })
  it('hotel-local differs from UTC midnight', () => {
    // 2026-10-14T21:00Z is already 2026-10-15 01:00 in Dubai: past a 00:00 same-day release even though UTC date is the 14th.
    expect(releaseAllows(new Date('2026-10-14T21:00:00Z'), '2026-10-15', 0, '00:00', 'Asia/Dubai')).toBe(false)
    expect(releaseAllows(new Date('2026-10-14T19:59:59Z'), '2026-10-15', 0, '00:00', 'Asia/Dubai')).toBe(true)
  })
  it('DST gap resolves later, overlap resolves earlier (America/New_York 2026)', () => {
    // 2026-03-08 02:30 does not exist; EST->EDT. Later reading = 03:30 EDT = 07:30Z.
    expect(zonedLocalToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // 2026-11-01 01:30 occurs twice; earlier = EDT (UTC-4) = 05:30Z.
    expect(zonedLocalToUtc('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z')
    // ordinary winter and summer days
    expect(zonedLocalToUtc('2026-01-15', '12:00', 'America/New_York').toISOString()).toBe('2026-01-15T17:00:00.000Z')
    expect(zonedLocalToUtc('2026-07-15', '12:00', 'America/New_York').toISOString()).toBe('2026-07-15T16:00:00.000Z')
  })
  it('release days across a DST change use local calendar days', () => {
    // checkIn 2026-03-09, 2 days before = 2026-03-07 00:00 EST = 05:00Z (before the change)
    expect(releaseDeadline('2026-03-09', 2, '00:00', 'America/New_York').toISOString()).toBe('2026-03-07T05:00:00.000Z')
    // checkIn 2026-03-09, 1 day before = 2026-03-08 00:00 EST (change happens at 02:00) = 05:00Z
    expect(releaseDeadline('2026-03-09', 1, '00:00', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    // checkIn 2026-03-09 itself 00:00 EDT = 04:00Z
    expect(releaseDeadline('2026-03-09', 0, '00:00', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })
  it('invalid zone, time or day fails closed', () => {
    expect(releaseAllows(new Date(0), '2026-10-15', 1, '00:00', 'Not/AZone')).toBe(false)
    expect(releaseAllows(new Date(0), '2026-10-15', 1, '24:00', 'Asia/Dubai')).toBe(false)
    expect(() => zonedLocalToUtc('2026-02-30', '00:00', 'Asia/Dubai')).toThrow(RangeError)
  })
})
