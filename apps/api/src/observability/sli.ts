/**
 * One structured SLI line per finished HTTP request (ADR 0112).
 * Fields are an event name, a fixed signal, an outcome, a status, a duration and an optional request id.
 * No path query, header, cookie, body, tenant id or guest data is written.
 */

export const SLI_EVENT = 'ops.sli'

const API_PREFIX = '/api/v1'
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/

export type SliSignal = 'authentication' | 'search' | 'recheck' | 'booking' | 'cancellation' | 'authorization' | 'other'
export type SliOutcome = 'ok' | 'denied' | 'client_error' | 'server_error'

export interface SliRecord {
  event: typeof SLI_EVENT
  signal: SliSignal
  outcome: SliOutcome
  status: number
  durationMs: number
  requestId?: string
}

export function routeTemplate(input: { baseUrl?: string; routePath?: string; path?: string }): string | undefined {
  const routePath = input.routePath
  const joined = routePath
    ? `${input.baseUrl ?? ''}${routePath.startsWith('/') ? routePath : `/${routePath}`}`
    : input.path
  if (!joined) return undefined
  const path = joined.split('?')[0]
  if (path.includes('@') || path.includes('=') || path.includes(' ')) return undefined
  const stripped = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) || '/' : path
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}

export function classifySignal(method: string, path: string): SliSignal | null {
  if (path === '/health' || path.startsWith('/health/')) return null
  if (path === '/auth' || path.startsWith('/auth/')) return 'authentication'
  if (path === '/agent/search' || path === '/agent/search/status' || path === '/agent/search/parse') return 'search'
  if (path === '/agent/rates/recheck') return 'recheck'
  if (method.toUpperCase() === 'POST' && path === '/agent/bookings') return 'booking'
  if (method.toUpperCase() === 'DELETE' && (path === '/agent/bookings/:id' || /^\/agent\/bookings\/[^/]+$/.test(path))) return 'cancellation'
  return 'other'
}

export function classifyOutcome(status: number): SliOutcome | null {
  if (!Number.isInteger(status) || status < 100 || status > 599) return null
  if (status >= 500) return 'server_error'
  if (status === 401 || status === 403) return 'denied'
  if (status >= 400) return 'client_error'
  return 'ok'
}

export function buildSliRecord(input: {
  method: string
  baseUrl?: string
  routePath?: string
  path?: string
  status: number
  durationMs: number
  requestId?: string
}): SliRecord | null {
  const template = routeTemplate(input)
  if (!template) return null
  const journey = classifySignal(input.method, template)
  if (!journey) return null
  const outcome = classifyOutcome(input.status)
  if (!outcome) return null
  const durationMs = Math.min(300_000, Math.max(0, Math.round(input.durationMs)))
  const signal: SliSignal = outcome === 'denied' && journey === 'other' ? 'authorization' : journey
  const record: SliRecord = { event: SLI_EVENT, signal, outcome, status: input.status, durationMs }
  if (input.requestId && SAFE_REQUEST_ID.test(input.requestId)) record.requestId = input.requestId
  return record
}

export function formatSli(record: SliRecord): string {
  return `${JSON.stringify(record)}\n`
}

export function writeSli(record: SliRecord, sink: (line: string) => void = (line) => process.stdout.write(line)): void {
  sink(formatSli(record))
}
