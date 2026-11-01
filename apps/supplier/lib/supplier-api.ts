import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { routes, type ExtranetBookingDetail, type ExtranetBookingList, type ExtranetBookingQuery, type ExtranetContractList, type ExtranetHotelList } from '@bedbanks/contracts'
import { apiInternalUrl, SESSION_COOKIE_NAME, SUPPLIER_CONTEXT_COOKIE, supplierOrigin } from './server-env'

export class SupplierApiError extends Error {
  constructor(readonly status: number) {
    super('Supplier API request failed')
  }
}

export interface PortalUser {
  id: string
  email: string
  name: string | null
}

export interface SupplierOrganization {
  supplierId: string
  displayName: string
  type: string
  supplierStatus: string
  defaultCurrency: string
  membershipStatus: string
}

export interface ExtranetHotel {
  id: string
  name: string
  city: string
  countryCode: string
  propertyType: string
  contentStatus: string
  mappingStatus: string
}

export interface ExtranetRoom {
  id: string
  name: string
  code: string
  maxAdults: number
  maxChildren: number
  maxOccupancy: number
  draft: { supplierNotes: string; updatedAt: string } | null
}

interface Identity {
  user: PortalUser
  memberships: { tenantId: string }[]
}

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SupplierApiError(response.status || 502)
  }
}

async function apiRequest(path: string, init: { method?: string; body?: unknown; supplierId?: string; requestId?: string; idempotencyKey?: string; cookieHeader: string; tenantId: string }): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${apiInternalUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: supplierOrigin(),
        Cookie: init.cookieHeader,
        'x-fbeds-tenant-id': init.tenantId,
        ...(init.supplierId ? { 'x-fbeds-supplier-id': init.supplierId } : {}),
        ...(init.requestId ? { 'X-Request-ID': init.requestId } : {}),
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new SupplierApiError(503)
  }
  const payload = await readJson(response)
  if (!response.ok || !isRecord(payload) || payload.success !== true) throw new SupplierApiError(response.status || 502)
  return payload.data
}

export const loadIdentity = cache(async (): Promise<{ cookieHeader: string; tenantId: string; user: PortalUser } | { ambiguous: true; user: PortalUser } | null> => {
  const cookieStore = await cookies()
  const session = cookieStore.get(SESSION_COOKIE_NAME)
  if (!session?.value) return null
  const cookieHeader = `${SESSION_COOKIE_NAME}=${session.value}`
  let response: Response
  try {
    response = await fetch(`${apiInternalUrl()}${routes.auth.me}`, {
      headers: { Accept: 'application/json', Origin: supplierOrigin(), Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new SupplierApiError(503)
  }
  const payload = await readJson(response)
  if (response.status === 401) return null
  if (!response.ok || !isRecord(payload) || payload.success !== true || !isRecord(payload.data)) throw new SupplierApiError(response.status || 502)
  const data = payload.data as Partial<Identity>
  if (!isRecord(data.user) || typeof data.user.email !== 'string' || !Array.isArray(data.memberships)) throw new SupplierApiError(502)
  const user = { id: String(data.user.id ?? ''), email: data.user.email, name: typeof data.user.name === 'string' ? data.user.name : null }
  if (data.memberships.length !== 1 || typeof data.memberships[0]?.tenantId !== 'string') return { ambiguous: true, user }
  return { cookieHeader, tenantId: data.memberships[0].tenantId, user }
})

async function authorizedRequest(path: string, init: { method?: string; body?: unknown; supplierId?: string; requestId?: string; idempotencyKey?: string } = {}): Promise<unknown> {
  const identity = await loadIdentity()
  if (!identity) throw new SupplierApiError(401)
  if ('ambiguous' in identity) throw new SupplierApiError(403)
  const cookieStore = await cookies()
  const supplierId = init.supplierId ?? cookieStore.get(SUPPLIER_CONTEXT_COOKIE)?.value
  return apiRequest(path, { ...init, cookieHeader: identity.cookieHeader, tenantId: identity.tenantId, supplierId })
}

function organization(value: unknown): SupplierOrganization | null {
  if (!isRecord(value) || typeof value.supplierId !== 'string' || typeof value.displayName !== 'string') return null
  return {
    supplierId: value.supplierId,
    displayName: value.displayName,
    type: typeof value.type === 'string' ? value.type : '',
    supplierStatus: typeof value.supplierStatus === 'string' ? value.supplierStatus : '',
    defaultCurrency: typeof value.defaultCurrency === 'string' ? value.defaultCurrency : '',
    membershipStatus: typeof value.membershipStatus === 'string' ? value.membershipStatus : 'ACTIVE',
  }
}

export async function listOrganizations(): Promise<SupplierOrganization[]> {
  const data = await authorizedRequest(routes.supplier.memberships)
  if (!isRecord(data) || !Array.isArray(data.organizations)) throw new SupplierApiError(502)
  return data.organizations.map(organization).filter((item): item is SupplierOrganization => item !== null)
}

export async function loadContext(supplierId?: string): Promise<{ organization: SupplierOrganization; permissions: string[] }> {
  const data = await authorizedRequest(routes.supplier.context, { supplierId })
  if (!isRecord(data) || !Array.isArray(data.permissions)) throw new SupplierApiError(502)
  const current = organization(isRecord(data.organization) ? { ...data.organization, membershipStatus: 'ACTIVE' } : null)
  if (!current) throw new SupplierApiError(502)
  return { organization: current, permissions: data.permissions.filter((key): key is string => typeof key === 'string') }
}

export interface PageQuery { cursor?: string; limit?: number }

function pageSuffix(query: PageQuery): string {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  return params.size > 0 ? `?${params.toString()}` : ''
}

export async function listHotels(query: PageQuery = {}): Promise<ExtranetHotelList> {
  const data = await authorizedRequest(`${routes.supplier.hotels}${pageSuffix(query)}`)
  if (!isRecord(data) || !Array.isArray(data.hotels) || !nullableString(data.nextCursor)) throw new SupplierApiError(502)
  const hotels = data.hotels.flatMap((hotel) => {
    if (!isRecord(hotel) || typeof hotel.id !== 'string' || typeof hotel.name !== 'string') return []
    return [{
      id: hotel.id,
      name: hotel.name,
      city: typeof hotel.city === 'string' ? hotel.city : '',
      countryCode: typeof hotel.countryCode === 'string' ? hotel.countryCode : '',
      propertyType: typeof hotel.propertyType === 'string' ? hotel.propertyType : '',
      contentStatus: typeof hotel.contentStatus === 'string' ? hotel.contentStatus : '',
      mappingStatus: typeof hotel.mappingStatus === 'string' ? hotel.mappingStatus : '',
    }]
  })
  return { hotels, nextCursor: data.nextCursor }
}

export async function getHotel(hotelId: string): Promise<ExtranetHotel> {
  const data = await authorizedRequest(routes.supplier.hotel.replace(':hotelId', encodeURIComponent(hotelId)))
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.name !== 'string') throw new SupplierApiError(502)
  return {
    id: data.id,
    name: data.name,
    city: typeof data.city === 'string' ? data.city : '',
    countryCode: typeof data.countryCode === 'string' ? data.countryCode : '',
    propertyType: typeof data.propertyType === 'string' ? data.propertyType : '',
    contentStatus: typeof data.contentStatus === 'string' ? data.contentStatus : '',
    mappingStatus: typeof data.mappingStatus === 'string' ? data.mappingStatus : '',
  }
}

export async function listRooms(hotelId: string): Promise<{ hotelId: string; hotelName: string; rooms: ExtranetRoom[] }> {
  const data = await authorizedRequest(routes.supplier.rooms.replace(':hotelId', encodeURIComponent(hotelId)))
  if (!isRecord(data) || typeof data.hotelId !== 'string' || !Array.isArray(data.rooms)) throw new SupplierApiError(502)
  return {
    hotelId: data.hotelId,
    hotelName: typeof data.hotelName === 'string' ? data.hotelName : '',
    rooms: data.rooms.flatMap((room) => {
      if (!isRecord(room) || typeof room.id !== 'string' || typeof room.name !== 'string') return []
      const draft = isRecord(room.draft) && typeof room.draft.supplierNotes === 'string'
        ? { supplierNotes: room.draft.supplierNotes, updatedAt: typeof room.draft.updatedAt === 'string' ? room.draft.updatedAt : '' }
        : null
      return [{
        id: room.id,
        name: room.name,
        code: typeof room.code === 'string' ? room.code : '',
        maxAdults: typeof room.maxAdults === 'number' ? room.maxAdults : 0,
        maxChildren: typeof room.maxChildren === 'number' ? room.maxChildren : 0,
        maxOccupancy: typeof room.maxOccupancy === 'number' ? room.maxOccupancy : 0,
        draft,
      }]
    }),
  }
}

export async function listContracts(query: PageQuery = {}): Promise<ExtranetContractList> {
  const data = await authorizedRequest(`${routes.supplier.contracts}${pageSuffix(query)}`)
  if (!isRecord(data) || !Array.isArray(data.contracts) || !nullableString(data.nextCursor)) throw new SupplierApiError(502)
  return data as unknown as ExtranetContractList
}

const BOOKING_NET_STATUSES = new Set(['RECORDED', 'PARTIAL', 'NOT_RECORDED', 'MISMATCH'])

/** Fails closed (502) on a shape the portal does not recognise; never fills a gap with a default or a zero. */
function booking(value: unknown): ExtranetBookingDetail {
  if (!isRecord(value)) throw new SupplierApiError(502)
  const { id, reference, status, hotelId, currency, netStatus, createdAt } = value
  if (typeof id !== 'string' || typeof reference !== 'string' || typeof status !== 'string' || typeof hotelId !== 'string' || typeof currency !== 'string' || typeof createdAt !== 'string') throw new SupplierApiError(502)
  if (typeof netStatus !== 'string' || !BOOKING_NET_STATUSES.has(netStatus)) throw new SupplierApiError(502)
  if (!nullableString(value.netMinor) || !nullableString(value.hotelName) || !nullableString(value.checkIn) || !nullableString(value.checkOut) || !nullableString(value.leadGuestName) || !nullableString(value.supplierRef)) throw new SupplierApiError(502)
  const rooms = Array.isArray(value.rooms) ? value.rooms : []
  return {
    id, reference, status: status as ExtranetBookingDetail['status'], hotelId, hotelName: value.hotelName, checkIn: value.checkIn, checkOut: value.checkOut,
    nights: typeof value.nights === 'number' ? value.nights : null, leadGuestName: value.leadGuestName, currency, netMinor: value.netMinor,
    netStatus: netStatus as ExtranetBookingDetail['netStatus'], supplierRef: value.supplierRef, createdAt,
    hotelConfirmationNo: typeof value.hotelConfirmationNo === 'string' ? value.hotelConfirmationNo : null,
    rooms: rooms.flatMap((room) => {
      if (!isRecord(room) || typeof room.position !== 'number' || !nullableString(room.netMinor)) return []
      return [{
        position: room.position, roomName: typeof room.roomName === 'string' ? room.roomName : null, boardCode: typeof room.boardCode === 'string' ? room.boardCode : null,
        quantity: typeof room.quantity === 'number' ? room.quantity : 1, adults: typeof room.adults === 'number' ? room.adults : 0, children: typeof room.children === 'number' ? room.children : 0,
        netMinor: room.netMinor,
      }]
    }),
  }
}

export async function listBookings(query: ExtranetBookingQuery = {}): Promise<ExtranetBookingList> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const data = await authorizedRequest(`${routes.supplier.bookings}${suffix}`)
  if (!isRecord(data) || !Array.isArray(data.bookings) || !nullableString(data.nextCursor)) throw new SupplierApiError(502)
  return { bookings: data.bookings.map((item) => { const { rooms: _rooms, hotelConfirmationNo: _hcn, ...summary } = booking(item); return summary }), nextCursor: data.nextCursor }
}

export async function getBooking(bookingId: string): Promise<ExtranetBookingDetail> {
  return booking(await authorizedRequest(routes.supplier.booking.replace(':bookingId', encodeURIComponent(bookingId))))
}

export async function saveRoomDraft(hotelId: string, roomId: string, supplierNotes: string, requestId: string): Promise<void> {
  const path = routes.supplier.roomDraft.replace(':hotelId', encodeURIComponent(hotelId)).replace(':roomId', encodeURIComponent(roomId))
  await authorizedRequest(path, { method: 'PATCH', body: { supplierNotes }, requestId })
}

export async function loginRequest(email: string, password: string, rememberMe = false): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(`${apiInternalUrl()}${routes.auth.login}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: supplierOrigin() },
      body: JSON.stringify({ email, password, ...(rememberMe ? { rememberMe: true } : {}) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new SupplierApiError(503)
  }
  if (!response.ok) throw new SupplierApiError(response.status)
  const payload = await readJson(response)
  if (!isRecord(payload) || payload.success !== true) throw new SupplierApiError(502)
  return response.headers.getSetCookie()
}

export async function logoutRequest(cookieHeader: string): Promise<void> {
  const response = await fetch(`${apiInternalUrl()}${routes.auth.logout}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: supplierOrigin(), Cookie: cookieHeader },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new SupplierApiError(response.status)
}

/** Public. A deployment that cannot really send email reports false, and the sign-in page then shows no reset link. Any failure also reads as false. */
export const loadAuthCapabilities = cache(async (): Promise<{ passwordReset: boolean }> => {
  try {
    const response = await fetch(`${apiInternalUrl()}${routes.auth.capabilities}`, { headers: { Accept: 'application/json', Origin: supplierOrigin() }, cache: 'no-store', signal: AbortSignal.timeout(5000) })
    const payload = await readJson(response)
    const data = isRecord(payload) && payload.success === true && isRecord(payload.data) ? payload.data : null
    return { passwordReset: response.ok && data?.passwordReset === true }
  } catch {
    return { passwordReset: false }
  }
})

async function publicPost(path: string, body: unknown): Promise<{ status: number; code: string | null; message: string | null }> {
  let response: Response
  try {
    response = await fetch(`${apiInternalUrl()}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: supplierOrigin() },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new SupplierApiError(503)
  }
  const payload = await readJson(response).catch(() => null)
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : isRecord(payload) ? payload : {}
  return { status: response.status, code: typeof error.code === 'string' ? error.code : null, message: typeof error.message === 'string' ? error.message : null }
}

/** Always resolves the same way for a well-formed request; the API does not say whether the account exists. */
export async function requestPasswordReset(email: string): Promise<void> {
  const result = await publicPost(routes.auth.passwordResetRequest, { email })
  if (result.status !== 202 && result.status !== 429) throw new SupplierApiError(result.status)
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<{ ok: true } | { ok: false; code: 'RESET_TOKEN_INVALID' | 'WEAK_PASSWORD'; message: string }> {
  const result = await publicPost(routes.auth.passwordResetConfirm, { token, newPassword })
  if (result.status === 200) return { ok: true }
  if (result.status === 422 && result.code === 'WEAK_PASSWORD') return { ok: false, code: 'WEAK_PASSWORD', message: result.message ?? 'Choose a stronger password.' }
  if (result.status === 400) return { ok: false, code: 'RESET_TOKEN_INVALID', message: 'This reset link is invalid or has expired.' }
  throw new SupplierApiError(result.status)
}
