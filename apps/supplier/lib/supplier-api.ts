import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { routes, type ExtranetBookingAnswerRequest, type ExtranetBookingAnswerResult, type ExtranetBookingDetail, type ExtranetBookingList, type ExtranetBookingQuery, type ExtranetContractList, type ExtranetHotelList } from '@bedbanks/contracts'
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

const ANSWER_STATUSES = new Set(['PENDING_SUPPLIER', 'ON_REQUEST', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CANCELLED', 'CHECKED_OUT', 'NO_SHOW', 'REJECTED', 'FAILED'])

/** ADR 0061 Amendment 2. The same idempotency key with the same body is safe to resend; a different body under the same key is a 409. */
export async function answerBooking(bookingId: string, body: ExtranetBookingAnswerRequest, idempotencyKey: string, requestId: string): Promise<ExtranetBookingAnswerResult> {
  const data = await authorizedRequest(routes.supplier.bookingAnswer.replace(':bookingId', encodeURIComponent(bookingId)), { method: 'POST', body, idempotencyKey, requestId })
  if (!isRecord(data) || typeof data.bookingId !== 'string' || typeof data.reference !== 'string' || typeof data.status !== 'string' || !ANSWER_STATUSES.has(data.status) || typeof data.replayed !== 'boolean') throw new SupplierApiError(502)
  return { bookingId: data.bookingId, reference: data.reference, status: data.status as ExtranetBookingAnswerResult['status'], replayed: data.replayed }
}

export async function loginRequest(email: string, password: string): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(`${apiInternalUrl()}${routes.auth.login}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: supplierOrigin() },
      body: JSON.stringify({ email, password }),
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
