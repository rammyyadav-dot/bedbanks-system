import { agencySuspendedMessage, isAgencySuspended } from '../lib/agency-suspension.mjs'
import { agentApiBase } from '../lib/api-config.mjs'

/**
 * Typed client for the transactional booking API. Every call sends the active tenant header (validated server-side)
 * and the session cookie; none of it fabricates data: a failed call yields an explicit outcome the UI must show.
 */
export type BookingFailure = { ok: false; kind: 'unavailable' | 'auth' | 'denied' | 'not_found' | 'conflict' | 'gone' | 'invalid' | 'error'; message: string }
export type BookingResult<T> = { ok: true; data: T } | BookingFailure

export type HoldOutcome = { status: string; holdId?: string; expiresAt?: string; currency?: string; sellAmountMinor?: number }
export type PrebookData = { status: 'prebooked'; bookingId: string; bookingReference: string }
export type ConfirmData = { bookingId: string; reference: string; status: 'CONFIRMED'; alreadyConfirmed: boolean }
export type BookingSummary = { id: string; reference: string; status: string; currency: string; totalMinor: string; createdAt: string; hotelName: string | null; checkIn: string | null; checkOut: string | null; rooms: number | null; leadGuest: string | null }
export type BookingTimelineEvent = { type: 'recorded' | 'cancelled'; at: string }
export type BookingPage = { items: BookingSummary[]; total: number; limit: number; offset: number }
export type BookingDetail = BookingSummary & {
  adults: number | null; children: number | null; cancellable: boolean; documents: Array<{ type: string; number: string }>
  timeline?: BookingTimelineEvent[]
  supplierMutation?: {
    bookingId: string; supplierKey: string; operation: string; mutationId: string; status: string
    supplierReference: string | null; attemptedAt: string | null; requestId: string; failureCategory: string | null; lastReconciledAt: string | null
  } | null
}
export type CancellationQuote = { bookingId: string; currency: string; totalMinor: string; penaltyMinor: string; refundMinor: string; checkIn: string; evaluatedAt: string }
export type CancellationData = CancellationQuote & { status: 'CANCELLED'; alreadyCancelled: boolean; cancellationId: string }
export type DocumentType = 'voucher' | 'invoice' | 'credit-note'
export type GuestInput = { adults: number; children: number; childAges: number[]; firstName: string; lastName: string }

const MINOR = /^-?\d+$/
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const failureFor = (status: number, message: string): BookingFailure => {
  if (status === 503 && /reconciliation/i.test(message)) return { ok: false, kind: 'error', message: 'Reconciliation required' }
  const kind = status === 401 ? 'auth' : status === 403 ? 'denied' : status === 404 ? 'not_found' : status === 409 || status === 422 ? 'conflict' : status === 410 ? 'gone' : status === 400 ? 'invalid' : 'error'
  const generic: Record<BookingFailure['kind'], string> = { unavailable: 'Booking is not enabled.', auth: 'Your session expired. Sign in again.', denied: 'You do not have permission for this action.', not_found: 'That booking was not found.',
    conflict: 'That could not be completed.', gone: 'That offer or hold has expired.', invalid: 'Some details are invalid.', error: 'The booking service is unavailable. Nothing was changed.' }
  return { ok: false, kind, message: kind === 'conflict' || kind === 'invalid' || kind === 'gone' ? (message || generic[kind]) : generic[kind] }
}

export class BookingService {
  private readonly base: string
  private readonly timeoutMs: number
  constructor(base = agentApiBase, timeoutMs = 15_000) { this.base = base; this.timeoutMs = timeoutMs }

  private async call(path: string, tenantId: string, init: RequestInit = {}): Promise<{ status: number; body: unknown } | BookingFailure> {
    if (!this.base || !tenantId) return failureFor(0, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.base}${path}`, { ...init, credentials: 'include', signal: controller.signal,
        headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), 'x-fbeds-tenant-id': tenantId, ...(init.headers as Record<string, string> | undefined) } })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, body }
    } catch { return failureFor(0, '') } finally { clearTimeout(timer) }
  }

  private parse<T>(result: { status: number; body: unknown } | BookingFailure, accept: (data: unknown) => data is T): BookingResult<T> {
    if ('ok' in result) return result
    const data = isRecord(result.body) && 'data' in result.body ? result.body.data : result.body
    if (isRecord(data) && data.status === 'booking_unavailable') return { ok: false, kind: 'unavailable', message: 'Booking is not enabled for this workspace yet.' }
    if (result.status >= 200 && result.status < 300) return accept(data) ? { ok: true, data } : failureFor(500, '')
    if (result.status === 403 && isAgencySuspended(result.body)) return { ok: false, kind: 'denied', message: agencySuspendedMessage }
    const message = isRecord(result.body) && isRecord(result.body.error) && typeof result.body.error.message === 'string' ? result.body.error.message : ''
    return failureFor(result.status, message)
  }

  /** Creates the inventory hold. The hold response carries a meaningful status even for non-2xx (unavailable, price_changed, …). */
  async hold(offerId: string, searchId: string, currency: string, sellAmountMinor: number, idempotencyKey: string, tenantId: string): Promise<BookingResult<HoldOutcome>> {
    const result = await this.call(`/agent/offers/${encodeURIComponent(offerId)}/hold`, tenantId, { method: 'POST', body: JSON.stringify({ searchId, expectedCurrency: currency, expectedSellAmountMinor: sellAmountMinor, idempotencyKey }) })
    if (!('ok' in result)) {
      const data = isRecord(result.body) && 'data' in result.body ? result.body.data : null
      if (isRecord(data) && typeof data.status === 'string' && data.status !== 'booking_unavailable') {
        const outcome: HoldOutcome = { status: data.status }
        if (typeof data.holdId === 'string') outcome.holdId = data.holdId
        if (typeof data.expiresAt === 'string' && Number.isFinite(Date.parse(data.expiresAt))) outcome.expiresAt = data.expiresAt
        if (typeof data.currency === 'string') outcome.currency = data.currency
        if (Number.isSafeInteger(data.sellAmountMinor)) outcome.sellAmountMinor = data.sellAmountMinor as number
        return { ok: true, data: outcome }
      }
    }
    return this.parse(result, (data): data is HoldOutcome => isRecord(data) && typeof data.status === 'string')
  }

  /** Gives the inventory back before the hold expires. Only possible while the hold is not yet part of a booking attempt. */
  async releaseHold(holdId: string, tenantId: string): Promise<BookingResult<{ holdId: string; status: 'RELEASED' | 'EXPIRED' }>> {
    return this.parse(await this.call(`/agent/holds/${encodeURIComponent(holdId)}`, tenantId, { method: 'DELETE' }),
      (data): data is { holdId: string; status: 'RELEASED' | 'EXPIRED' } => isRecord(data) && typeof data.holdId === 'string' && (data.status === 'RELEASED' || data.status === 'EXPIRED'))
  }

  async prebook(holdId: string, guest: GuestInput, tenantId: string): Promise<BookingResult<PrebookData>> {
    const body = { inventoryHoldId: holdId, idempotencyKey: `prebook-${holdId}`, adults: guest.adults, children: guest.children, childAges: guest.childAges, leadGuest: { firstName: guest.firstName.trim(), lastName: guest.lastName.trim() } }
    return this.parse(await this.call('/agent/prebook', tenantId, { method: 'POST', body: JSON.stringify(body) }),
      (data): data is PrebookData => isRecord(data) && data.status === 'prebooked' && typeof data.bookingId === 'string' && typeof data.bookingReference === 'string')
  }

  async confirm(bookingId: string, tenantId: string): Promise<BookingResult<ConfirmData>> {
    return this.parse(await this.call('/agent/bookings', tenantId, { method: 'POST', body: JSON.stringify({ bookingId }) }),
      (data): data is ConfirmData => isRecord(data) && data.status === 'CONFIRMED' && typeof data.bookingId === 'string' && typeof data.reference === 'string')
  }

  async list(tenantId: string, query: { limit?: number; offset?: number; status?: string } = {}): Promise<BookingResult<BookingPage>> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.offset !== undefined) params.set('offset', String(query.offset))
    if (query.status) params.set('status', query.status)
    const suffix = params.size ? `?${params.toString()}` : ''
    return this.parse(await this.call(`/agent/bookings${suffix}`, tenantId), isBookingPage)
  }

  async detail(bookingId: string, tenantId: string): Promise<BookingResult<BookingDetail>> {
    return this.parse(await this.call(`/agent/bookings/${encodeURIComponent(bookingId)}`, tenantId),
      (data): data is BookingDetail => isBookingSummary(data) && typeof (data as Record<string, unknown>).cancellable === 'boolean' && Array.isArray((data as Record<string, unknown>).documents) && isTimeline((data as Record<string, unknown>).timeline))
  }

  async cancellationQuote(bookingId: string, tenantId: string): Promise<BookingResult<CancellationQuote>> {
    return this.parse(await this.call(`/agent/bookings/${encodeURIComponent(bookingId)}/cancellation-quote`, tenantId), isQuote)
  }

  async cancel(bookingId: string, reason: string, tenantId: string): Promise<BookingResult<CancellationData>> {
    return this.parse(await this.call(`/agent/bookings/${encodeURIComponent(bookingId)}`, tenantId, { method: 'DELETE', body: JSON.stringify({ reason: reason.trim().slice(0, 500) }) }),
      (data): data is CancellationData => isQuote(data) && (data as Record<string, unknown>).status === 'CANCELLED')
  }

  /** Printable HTML for a document. The caller opens it in a new tab; it is escaped, script-free and CSP-locked by the API. */
  async documentHtml(bookingId: string, type: DocumentType, tenantId: string): Promise<BookingResult<string>> {
    if (!this.base || !tenantId) return failureFor(0, '')
    try {
      const response = await fetch(`${this.base}/agent/bookings/${encodeURIComponent(bookingId)}/documents/${type}/html`, { credentials: 'include', headers: { 'x-fbeds-tenant-id': tenantId } })
      if (response.status === 503) return { ok: false, kind: 'unavailable', message: 'Booking is not enabled for this workspace yet.' }
      if (!response.ok) { const body: unknown = await response.json().catch(() => null); return failureFor(response.status, isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : '') }
      return { ok: true, data: await response.text() }
    } catch { return failureFor(0, '') }
  }
}

function isTimeline(value: unknown): boolean {
  if (value === undefined) return true
  return Array.isArray(value) && value.every((event) => isRecord(event) && (event.type === 'recorded' || event.type === 'cancelled') && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)))
}
function isBookingPage(value: unknown): value is BookingPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isBookingSummary)) return false
  const { total, limit, offset, items } = value
  return Number.isSafeInteger(total) && (total as number) >= 0 && Number.isSafeInteger(limit) && (limit as number) >= 1 && Number.isSafeInteger(offset) && (offset as number) >= 0 && items.length <= (limit as number) && (offset as number) + items.length <= Math.max(total as number, offset as number)
}
function isBookingSummary(value: unknown): value is BookingSummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.reference === 'string' && typeof value.status === 'string' && typeof value.currency === 'string' && typeof value.totalMinor === 'string' && MINOR.test(value.totalMinor)
}
function isQuote(value: unknown): value is CancellationQuote {
  return isRecord(value) && typeof value.bookingId === 'string' && typeof value.currency === 'string' && ['totalMinor', 'penaltyMinor', 'refundMinor'].every((key) => typeof value[key] === 'string' && MINOR.test(value[key] as string))
}
