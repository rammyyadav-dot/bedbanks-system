import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  BOOKING_DATE_TYPES, BOOKING_NEEDS_ACTION_STATUSES, BOOKING_PAGE_SIZES, BOOKING_PAYMENT_MODES, BOOKING_PAYMENT_STATUSES, BOOKING_QUICK_SEARCHES, BOOKING_SORTS, BOOKING_STATUSES, BOOKING_UNASSIGNED_AGENCY,
  type BookingAccessView, type BookingDateType, type BookingQuickSearch, type BookingSort, type BookingStatus,
} from '@bedbanks/contracts'
import { boolParam, dayParam, endOfDay, enumParam, idParam, likeLiteral, textParam } from '../admin-operations/query-params'

/**
 * Pure parsing and query building for the booking list (ADR 0039). No I/O and no clock: `now` is injected, so every chip is deterministic under test.
 * Everything is validated and bounded; an unknown value is a 400, never silently widened. The caller's scope (tenant, agency) is applied by the
 * builder from the authenticated access, never from a query parameter.
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
  statuses: BookingStatus[]
  supplierStatus: string | null
  dateType: BookingDateType | null
  from: Date | null
  to: Date | null
  paymentMode: string | null
  paymentStatus: string | null
  missingSupplierRef: boolean
  nonRefundable: boolean
  amended: boolean
  attention: boolean
  sort: BookingSort
  dir: 'asc' | 'desc'
  page: number
  pageSize: number
}

const REFERENCE = /^[A-Za-z0-9._\- /]{1,64}$/
const csv = (value: unknown): string[] => (typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [])

/** Default sort for a chip when the caller does not choose one. Phase 4 replaces needsAction with nearest SLA breach. */
const CHIP_SORT: Record<BookingQuickSearch, { sort: BookingSort; dir: 'asc' | 'desc' }> = {
  needsAction: { sort: 'created', dir: 'asc' }, latest: { sort: 'created', dir: 'desc' }, checkInNext7: { sort: 'checkIn', dir: 'asc' }, missingSupplierRef: { sort: 'created', dir: 'asc' },
  deadline48h: { sort: 'deadline', dir: 'asc' }, failed: { sort: 'created', dir: 'desc' }, latestCancelled: { sort: 'created', dir: 'desc' }, onRequest: { sort: 'created', dir: 'asc' },
  unpaid: { sort: 'created', dir: 'asc' }, noShowCandidates: { sort: 'checkIn', dir: 'desc' },
}

export function parseBookingListQuery(raw: Record<string, unknown>, access: BookingAccessView): BookingFilter {
  const chip = enumParam('chip', raw.chip, BOOKING_QUICK_SEARCHES) ?? null
  const referenceText = textParam('reference', raw.reference, 64)
  if (referenceText && !REFERENCE.test(referenceText)) throw new BadRequestException('Invalid reference')
  const guest = textParam('guest', raw.guest, 60) ?? null
  if (guest !== null) {
    if (guest.length < 2) throw new BadRequestException('Guest search needs at least 2 characters')
    // Searching names would confirm that a guest exists to a reader who may not see names.
    if (!access.canViewPii) throw new ForbiddenException('Access denied')
  }
  const requestedAgencies = csv(raw.agencyId)
  if (requestedAgencies.length > 25) throw new BadRequestException('Invalid agencyId')
  for (const id of requestedAgencies) if (id !== BOOKING_UNASSIGNED_AGENCY) idParam('agencyId', id)
  if (access.level === 'AGENCY' && requestedAgencies.some((id) => id !== access.agencyId)) throw new ForbiddenException('Access denied')
  const statuses = csv(raw.status).map((s) => enumParam('status', s, BOOKING_STATUSES) as BookingStatus)
  if (statuses.length > BOOKING_STATUSES.length) throw new BadRequestException('Invalid status')
  const from = dayParam('from', raw.from) ?? null
  const to = dayParam('to', raw.to) ?? null
  if (from && to && from > to) throw new BadRequestException('from must not be after to')
  const dateType = enumParam('dateType', raw.dateType, BOOKING_DATE_TYPES) ?? (from || to ? 'created' : null)
  const pageSize = raw.pageSize === undefined || raw.pageSize === '' ? 25 : Number(raw.pageSize)
  if (!(BOOKING_PAGE_SIZES as readonly number[]).includes(pageSize)) throw new BadRequestException('Invalid pageSize (25, 50 or 100)')
  const page = raw.page === undefined || raw.page === '' ? 1 : Number(raw.page)
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new BadRequestException('Invalid page')
  const chipSort = chip ? CHIP_SORT[chip] : { sort: 'created' as BookingSort, dir: 'desc' as const }
  return {
    chip, reference: referenceText ?? null, guest,
    agencyIds: requestedAgencies.filter((id) => id !== BOOKING_UNASSIGNED_AGENCY),
    includeUnassigned: requestedAgencies.includes(BOOKING_UNASSIGNED_AGENCY),
    supplier: textParam('supplier', raw.supplier, 64) ?? null,
    hotelId: idParam('hotelId', raw.hotelId) ?? null,
    hotelText: ((): string | null => { const t = textParam('hotel', raw.hotel, 60) ?? null; if (t !== null && t.length < 2) throw new BadRequestException('Hotel search needs at least 2 characters'); return t })(),
    statuses: [...new Set(statuses)],
    supplierStatus: textParam('supplierStatus', raw.supplierStatus, 40) ?? null,
    dateType, from, to,
    paymentMode: enumParam('paymentMode', raw.paymentMode, BOOKING_PAYMENT_MODES) ?? null,
    paymentStatus: enumParam('paymentStatus', raw.paymentStatus, BOOKING_PAYMENT_STATUSES) ?? null,
    missingSupplierRef: boolParam('missingSupplierRef', raw.missingSupplierRef) === true,
    nonRefundable: boolParam('nonRefundable', raw.nonRefundable) === true,
    amended: boolParam('amended', raw.amended) === true,
    attention: boolParam('attention', raw.attention) === true,
    sort: enumParam('sort', raw.sort, BOOKING_SORTS) ?? chipSort.sort,
    dir: enumParam('dir', raw.dir, ['asc', 'desc'] as const) ?? chipSort.dir,
    page, pageSize,
  }
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
  if (filter.dateType && (filter.from || filter.to)) {
    const column = { created: 'createdAt', checkIn: 'checkIn', checkOut: 'checkOut', cancelDeadline: 'cancelDeadline' }[filter.dateType] as 'createdAt' | 'checkIn' | 'checkOut' | 'cancelDeadline'
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
  add('supplier', 'Supplier', filter.supplier); add('hotel', 'Hotel', filter.hotelText ?? filter.hotelId)
  add('status', 'Status', filter.statuses.join(', ')); add('supplierStatus', 'Supplier status', filter.supplierStatus)
  if (filter.dateType && (filter.from || filter.to)) add('dateType', filter.dateType, `${filter.from?.toISOString().slice(0, 10) ?? '…'} to ${filter.to?.toISOString().slice(0, 10) ?? '…'}`)
  add('paymentMode', 'Payment mode', filter.paymentMode); add('paymentStatus', 'Payment status', filter.paymentStatus)
  add('missingSupplierRef', 'Only missing supplier ref', filter.missingSupplierRef && 'yes'); add('nonRefundable', 'Only non-refundable', filter.nonRefundable && 'yes')
  add('amended', 'Only amended', filter.amended && 'yes'); add('attention', 'Only with reconciliation flags', filter.attention && 'yes')
  return out
}
