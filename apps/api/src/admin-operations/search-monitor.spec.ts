import { buildSearchMonitor, eventStatus, type SearchEventRow } from './search-monitor'

const win = { from: '2026-10-05', to: '2026-10-11', days: 7 }
const ev = (action: string, at: string, payload: Record<string, unknown>): SearchEventRow => ({ action, createdAt: new Date(at), payload })

describe('search monitor aggregation', () => {
  const rows = [
    ev('hotel.search', '2026-10-11T10:00:00Z', { status: 'available', destination: 'Dubai', requestId: 'r1' }),
    ev('hotel.search', '2026-10-11T09:00:00Z', { status: 'no_availability', destination: 'Dubai', requestId: 'r2' }),
    ev('hotel.search', '2026-10-10T09:00:00Z', { status: 'provider_unavailable', destination: 'Abu Dhabi', requestId: 'r3' }),
    ev('hotel.search.mapping_unavailable', '2026-10-10T08:00:00Z', { destination: 'Dubai', requestId: 'r4' }),
    ev('hotel.search', '2026-10-10T07:00:00Z', { status: 'bogus' }),
    ev('hotel.search', '2026-10-10T06:00:00Z', {}),
  ]
  it('counts by status, day and destination and skips events with an unreadable status', () => {
    const v = buildSearchMonitor(rows, win)
    expect(v.total).toBe(4)
    expect(v.byStatus).toEqual({ available: 1, partial: 0, no_availability: 1, provider_unavailable: 1, mapping_unavailable: 1 })
    expect(v.byDay.map((d) => [d.date, d.total])).toEqual([['2026-10-10', 2], ['2026-10-11', 2]])
    expect(v.problemDestinations[0]).toMatchObject({ destination: 'Dubai', total: 2 })
    expect(v.recent.map((r) => r.requestId)).toEqual(['r2', 'r3', 'r4'])
    expect(v.truncated).toBe(false)
  })
  it('a provider failure is never counted as no availability', () => {
    expect(eventStatus(rows[2]!)).toBe('provider_unavailable')
    expect(buildSearchMonitor([rows[2]!], win).byStatus.no_availability).toBe(0)
  })
  it('flags truncation when more events exist than the cap', () => {
    const v = buildSearchMonitor(rows, win, 2)
    expect(v.truncated).toBe(true); expect(v.total).toBe(2)
  })
  it('an empty window is an honest zero, not an error', () => {
    const v = buildSearchMonitor([], win)
    expect(v.total).toBe(0); expect(v.byDay).toEqual([]); expect(v.recent).toEqual([])
  })
})
