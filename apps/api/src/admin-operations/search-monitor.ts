import { SEARCH_MONITOR_STATUSES, type SearchMonitorCounts, type SearchMonitorStatus, type SearchMonitorView } from '@bedbanks/contracts'

export const SEARCH_MONITOR_READ_CAP = 5000
export const SEARCH_MONITOR_ACTIONS = ['hotel.search', 'hotel.search.mapping_unavailable'] as const

export interface SearchEventRow { action: string; createdAt: Date; payload: unknown }

const empty = (): SearchMonitorCounts => ({ available: 0, partial: 0, no_availability: 0, provider_unavailable: 0, mapping_unavailable: 0 })
const isStatus = (v: unknown): v is SearchMonitorStatus => typeof v === 'string' && (SEARCH_MONITOR_STATUSES as readonly string[]).includes(v)

/** The status an event records. An event whose status cannot be read is skipped, never counted as a success. */
export function eventStatus(row: SearchEventRow): SearchMonitorStatus | null {
  if (row.action === 'hotel.search.mapping_unavailable') return 'mapping_unavailable'
  const status = (row.payload as { status?: unknown } | null)?.status
  return isStatus(status) ? status : null
}

/** Pure aggregation over newest-first events. `rows.length > cap` means older events were left out. */
export function buildSearchMonitor(rows: readonly SearchEventRow[], window: { from: string; to: string; days: number }, cap = SEARCH_MONITOR_READ_CAP): SearchMonitorView {
  const truncated = rows.length > cap
  const used = rows.slice(0, cap)
  const byStatus = empty()
  const days = new Map<string, SearchMonitorCounts>()
  const destinations = new Map<string, SearchMonitorCounts>()
  const recent: SearchMonitorView['recent'] = []
  let total = 0
  for (const row of used) {
    const status = eventStatus(row)
    if (!status) continue
    total += 1; byStatus[status] += 1
    const date = row.createdAt.toISOString().slice(0, 10)
    const day = days.get(date) ?? empty(); day[status] += 1; days.set(date, day)
    const p = (row.payload ?? {}) as { destination?: unknown; requestId?: unknown }
    const destination = typeof p.destination === 'string' && p.destination.trim() ? p.destination.trim().slice(0, 80) : '(unspecified)'
    if (status !== 'available') {
      const d = destinations.get(destination) ?? empty(); d[status] += 1; destinations.set(destination, d)
      if (recent.length < 25) recent.push({ at: row.createdAt.toISOString(), destination, status, requestId: typeof p.requestId === 'string' ? p.requestId : null })
    }
  }
  const sum = (c: SearchMonitorCounts) => Object.values(c).reduce((a, b) => a + b, 0)
  return {
    window, truncated, total, byStatus,
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, total: sum(counts), counts })),
    problemDestinations: [...destinations.entries()].map(([destination, counts]) => ({ destination, total: sum(counts), counts })).sort((a, b) => b.total - a.total || a.destination.localeCompare(b.destination)).slice(0, 10),
    recent,
    definitions: {
      scope: 'Built from the audit record of Agent searches that were executed. Searches answered from a cache are not recorded and are not counted. This is an outcome monitor, not a root-cause analysis.',
      no_availability: 'The search ran, every queried source answered, and no sellable offer matched. The monitor does not say which rule removed the offers; use the hotel Distribution & Readiness tab for per-hotel blockers.',
      provider_unavailable: 'A source failed or timed out. This is a failure, not an empty market, and no substitute offer was returned.',
      mapping_unavailable: 'The source answered but its offers could not be validated against canonical hotel mappings, so none were returned.',
      partial: 'Some offers were returned while at least one source failed.',
    },
  }
}
