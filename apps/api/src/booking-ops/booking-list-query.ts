import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  BOOKING_NEEDS_ACTION_STATUSES, BOOKING_UNASSIGNED_AGENCY, normalizeBookingQuery,
  type BookingAccessView, type BookingFinanceEventType, type BookingQueryDateType, type BookingQueryV1, type BookingQuickSearch, type BookingSort, type BookingSource, type BookingStatus,
} from '@bedbanks/contracts'
import { endOfDay, likeLiteral } from '../admin-operations/query-params'

/**
 * Query building for the booking list (ADR 0039). Parsing and validation live in ONE place, `normalizeBookingQuery` in `@bedbanks/contracts` (Phase 6A);
 * this file adds what the contract deliberately cannot know: who is asking. Pure: no I/O and no clock (`now` is injected). The caller's scope (tenant, agency)
 * is applied by the builder from the authenticated access, never from a query parameter, and a field the caller may not use is a 403, never ignored.
 */
export interface BookingFilter {
  chip: BookingQuickSearch | null
  reference: string | null
  guest: string | null
  agencyIds: string[]
  includeUnassigned: boolean
  supplier: string | null
  hotelId: string | null
  hotelText: string | null
  destination: string | null
  statuses: BookingStatus[]
  supplierStatus: string | null
  dateType: BookingQueryDateType | null
  from: Date | null
  to: Date | null
  paymentMode: string | null
  paymentStatus: string | null
  source: BookingSource | null
  currency: string | null
  amountMin: bigint | null
  amountMax: bigint | null
  opsOwner: string | null
  moneyEvent: BookingFinanceEventType | null
  missingSupplierRef: boolean
  nonRefundable: boolean
  amended: boolean
  attention: boolean
  sort: BookingSort
  dir: 'asc' | 'desc'
  page: number
  pageSize: number
}

/** The fields whose use depends on what the caller may see. Row scope is separate (the builder). */
export function assertQueryAccess(query: BookingQueryV1, access: BookingAccessView): void {
  const deny = () => { throw new ForbiddenException('Access denied') }
  // Searching names would confirm that a guest exists to a reader who may not see names.
  if (query.guest !== null && !access.canViewPii) deny()
  if (access.level === 'AGENCY') {
    if (query.agencyIds.some((id) => id !== access.agencyId)) deny()
    if (query.opsOwner !== null || query.moneyEvent !== null) deny()
  } else {
    // Filtering on a fact is a way of reading it: the same permission that shows it is needed to filter by it.
    if (query.moneyEvent !== null && !access.permissions.includes('booking.finance.view')) deny()
    if (query.opsOwner !== null && !access.permissions.includes('booking.ops.view')) deny()
  }
}

export function toBookingFilter(query: BookingQueryV1, page: { page: number; pageSize: number }): BookingFilter {
  return {
    chip: query.chip, reference: query.reference, guest: query.guest,
    agencyIds: query.agencyIds.filter((id) => id !== BOOKING_UNASSIGNED_AGENCY), includeUnassigned: query.agencyIds.includes(BOOKING_UNASSIGNED_AGENCY),
    supplier: query.supplier, hotelId: query.hotelId, hotelText: query.hotel, destination: query.destination, statuses: query.statuses, supplierStatus: query.supplierStatus,
    dateType: query.dateType, from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : null, to: query.to ? new Date(`${query.to}T00:00:00.000Z`) : null,
    paymentMode: query.paymentMode, paymentStatus: query.paymentStatus, source: query.source, currency: query.currency,
    amountMin: query.amountMin === null ? null : BigInt(query.amountMin), amountMax: query.amountMax === null ? null : BigInt(query.amountMax),
    opsOwner: query.opsOwner, moneyEvent: query.moneyEvent,
    missingSupplierRef: query.missingSupplierRef, nonRefundable: query.nonRefundable, amended: query.amended, attention: query.attention,
    sort: query.sort, dir: query.dir, page: page.page, pageSize: page.pageSize,
  }
}

/** A malformed or unsupported query is always a 400 that names every problem at once. */
export function invalidQuery(issues: Array<{ field: string; code: string; message: string }>): BadRequestException {
  return new BadRequestException({ message: issues[0]?.message ?? 'Invalid query', code: 'BOOKING_QUERY_INVALID', issues })
}

/** Normalizes, then applies the caller's access. The one entry every consumer (list, saved views, bulk, export, reconciliation) goes through. */
export function parseBookingListQuery(raw: Record<string, unknown>, access: BookingAccessView): BookingFilter {
  const result = normalizeBookingQuery(raw)
  if (!result.ok) throw invalidQuery(result.issues)
  assertQueryAccess(result.query, access)
  return toBookingFilter(result.query, result.page)
}

const DAY_MS = 86_400_000
const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** The Prisma `where` for one list request. `hotelIds` is the already-resolved hotel set (null means no hotel filter). */
export function buildBookingWhere(filter: BookingFilter, scope: { tenantId: string; access: BookingAccessView }, hotelIds: string[] | null, now: Date): Prisma.BookingWhereInput {
  const and: Prisma.BookingWhereInput[] = []
  const today = startOfUtcDay(now)
  if (scope.access.level === 'AGENCY') and.push({ agencyId: scope.access.agencyId ?? '__none__' })
  else if (filter.agencyIds.length || filter.includeUnassigned) {
    and.push({ OR: [...(filter.agencyIds.length ? [{ agencyId: { in: filter.agencyIds } }] : []), ...(filter.includeUnassigned ? [{ agencyId: null }] : [])] })
  }
  if (filter.reference) {
    const exact = { equals: filter.reference, mode: 'insensitive' as const }
    and.push({ OR: [{ reference: { startsWith: likeLiteral(filter.reference.toUpperCase()) } }, { supplierRef: exact }, { hotelConfirmationNo: exact }, { agentRef: exact }] })
  }
  if (filter.guest) {
    const contains = { contains: likeLiteral(filter.guest), mode: 'insensitive' as const }
    and.push({ guests: { some: { OR: [{ firstName: contains }, { lastName: contains }] } } })
  }
  if (filter.supplier) and.push({ supplier: filter.supplier })
  if (filter.hotelId) and.push({ hotelId: filter.hotelId })
  if (hotelIds !== null) and.push({ hotelId: { in: hotelIds } })
  if (filter.statuses.length) and.push({ status: { in: filter.statuses } })
  if (filter.supplierStatus) and.push({ supplierStatus: { equals: filter.supplierStatus, mode: 'insensitive' } })
  if (filter.paymentMode) and.push({ paymentMode: filter.paymentMode as never })
  if (filter.paymentStatus) and.push({ paymentStatus: filter.paymentStatus as never })
  if (filter.missingSupplierRef) and.push({ status: 'CONFIRMED', supplierRef: null })
  if (filter.nonRefundable) and.push({ isRefundable: false })
  if (filter.amended) and.push({ version: { gt: 1 } })
  if (filter.source) and.push({ channel: filter.source })
  if (filter.currency) and.push({ currency: filter.currency })
  if (filter.amountMin !== null || filter.amountMax !== null) and.push({ totalMinor: { ...(filter.amountMin !== null && { gte: filter.amountMin }), ...(filter.amountMax !== null && { lte: filter.amountMax }) } })
  if (filter.opsOwner === BOOKING_UNASSIGNED_AGENCY) and.push({ OR: [{ opsState: { is: null } }, { opsState: { is: { assigneeUserId: null } } }] })
  else if (filter.opsOwner) and.push({ opsState: { is: { assigneeUserId: filter.opsOwner } } })
  if (filter.moneyEvent) and.push({ financeEvents: { some: { type: filter.moneyEvent } } })
  if (filter.dateType && (filter.from || filter.to)) {
    const column = { created: 'createdAt', updated: 'updatedAt', checkIn: 'checkIn', checkOut: 'checkOut', cancelDeadline: 'cancelDeadline' }[filter.dateType] as 'createdAt' | 'updatedAt' | 'checkIn' | 'checkOut' | 'cancelDeadline'
    // Date columns compare on the calendar day; timestamp columns include the whole last day.
    const isDay = column === 'checkIn' || column === 'checkOut'
    and.push({ [column]: { ...(filter.from && { gte: filter.from }), ...(filter.to && { lte: isDay ? filter.to : endOfDay(filter.to) }) } })
  }
  switch (filter.chip) {
    case 'needsAction': and.push({ closedAt: null, OR: [{ status: { in: [...BOOKING_NEEDS_ACTION_STATUSES] } }, { status: 'CONFIRMED', supplierRef: null }] }); break
    case 'checkInNext7': and.push({ status: { notIn: ['CANCELLED', 'FAILED', 'REJECTED'] }, checkIn: { gte: today, lte: new Date(today.getTime() + 7 * DAY_MS) } }); break
    case 'missingSupplierRef': and.push({ status: 'CONFIRMED', supplierRef: null }); break
    case 'deadline48h': and.push({ status: { in: ['CONFIRMED', 'AMEND_REQUESTED'] }, cancelDeadline: { gte: now, lte: new Date(now.getTime() + 2 * DAY_MS) } }); break
    case 'failed': and.push({ status: 'FAILED', closedAt: null }); break
    case 'latestCancelled': and.push({ status: 'CANCELLED' }); break
    case 'onRequest': and.push({ status: 'ON_REQUEST' }); break
    case 'unpaid': and.push({ paymentStatus: { in: ['UNPAID', 'OVERDUE'] } }); break
    case 'noShowCandidates': and.push({ status: 'CONFIRMED', checkIn: { gte: new Date(today.getTime() - 7 * DAY_MS), lte: today } }); break
    default: break
  }
  return { tenantId: scope.tenantId, ...(and.length ? { AND: and } : {}) }
}

export function buildBookingOrderBy(filter: BookingFilter): Prisma.BookingOrderByWithRelationInput[] {
  const dir = filter.dir
  // Nulls last in both directions so a booking with an unknown date never leads the list. The id breaks every tie, so paging is stable.
  const key: Record<BookingSort, Prisma.BookingOrderByWithRelationInput> = {
    created: { createdAt: dir }, checkIn: { checkIn: { sort: dir, nulls: 'last' } }, checkOut: { checkOut: { sort: dir, nulls: 'last' } },
    deadline: { cancelDeadline: { sort: dir, nulls: 'last' } }, amount: { totalMinor: dir },
  }
  return [key[filter.sort], { id: 'desc' }]
}

/** A readable list of the filters in force, for an empty state that names what removed everything. */
export function describeApplied(filter: BookingFilter): Array<{ key: string; label: string; value: string }> {
  const out: Array<{ key: string; label: string; value: string }> = []
  const add = (key: string, label: string, value: string | null | undefined | false) => { if (value) out.push({ key, label, value: String(value) }) }
  add('chip', 'Quick search', filter.chip)
  add('reference', 'Reference', filter.reference); add('guest', 'Guest', filter.guest)
  add('agencyId', 'Agency', [...filter.agencyIds, ...(filter.includeUnassigned ? ['Unassigned'] : [])].join(', '))
  add('supplier', 'Supplier', filter.supplier); add('hotel', 'Hotel', filter.hotelText ?? filter.hotelId); add('destination', 'Destination', filter.destination)
  add('source', 'Source', filter.source); add('currency', 'Currency', filter.currency)
  add('amountMin', 'Amount from', filter.amountMin !== null && filter.amountMin.toString()); add('amountMax', 'Amount to', filter.amountMax !== null && filter.amountMax.toString())
  add('opsOwner', 'Operations owner', filter.opsOwner); add('moneyEvent', 'Money event', filter.moneyEvent)
  add('status', 'Status', filter.statuses.join(', ')); add('supplierStatus', 'Supplier status', filter.supplierStatus)
  if (filter.dateType && (filter.from || filter.to)) add('dateType', filter.dateType, `${filter.from?.toISOString().slice(0, 10) ?? '…'} to ${filter.to?.toISOString().slice(0, 10) ?? '…'}`)
  add('paymentMode', 'Payment mode', filter.paymentMode); add('paymentStatus', 'Payment status', filter.paymentStatus)
  add('missingSupplierRef', 'Only missing supplier ref', filter.missingSupplierRef && 'yes'); add('nonRefundable', 'Only non-refundable', filter.nonRefundable && 'yes')
  add('amended', 'Only amended', filter.amended && 'yes'); add('attention', 'Only with reconciliation flags', filter.attention && 'yes')
  return out
}
