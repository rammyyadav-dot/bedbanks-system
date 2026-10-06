import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { BOOKING_QUICK_SEARCHES, type BookingAccessView } from '@bedbanks/contracts'
import { buildBookingOrderBy, buildBookingWhere, describeApplied, parseBookingListQuery } from './booking-list-query'
import { guestName, maskedGuestName } from './booking-masking'

const NOW = new Date('2030-06-10T10:30:00.000Z')
const operator: BookingAccessView = { level: 'OPERATOR', canViewNet: false, canViewPii: false, agencyId: null }
const operatorPii: BookingAccessView = { ...operator, canViewPii: true }
const agency: BookingAccessView = { level: 'AGENCY', canViewNet: false, canViewPii: false, agencyId: 'ag-1' }
const where = (raw: Record<string, unknown> = {}, access = operator, hotelIds: string[] | null = null) => buildBookingWhere(parseBookingListQuery(raw, access), { tenantId: 't1', access }, hotelIds, NOW)
const and = (w: ReturnType<typeof where>) => ((w as { AND?: unknown[] }).AND ?? []) as Array<Record<string, any>>

describe('booking list query (ADR 0039, Phase 1)', () => {
  it('BK-Q01: defaults are newest first, 25 per page, tenant scoped, with no other filter', () => {
    const f = parseBookingListQuery({}, operator)
    expect(f).toMatchObject({ chip: null, sort: 'created', dir: 'desc', page: 1, pageSize: 25, statuses: [] })
    expect(where()).toEqual({ tenantId: 't1' })
    expect(buildBookingOrderBy(f)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('BK-Q02: unknown values are rejected, never widened', () => {
    for (const raw of [{ status: 'PENDING' }, { status: 'CONFIRMED,NOPE' }, { chip: 'everything' }, { pageSize: '30' }, { pageSize: '1000' }, { page: '0' }, { page: 'x' }, { sort: 'name' }, { dir: 'sideways' }, { dateType: 'booked' }, { from: '2030-02-31' }, { paymentStatus: 'LATE' }, { reference: 'FB-<script>' }, { reference: 'x'.repeat(65) }, { hotel: 'a' }, { from: '2030-06-10', to: '2030-06-01' }]) {
      expect(() => parseBookingListQuery(raw, operator)).toThrow(BadRequestException)
    }
  })

  it('BK-Q03: multi-select status, supplier, payment and toggles combine with AND', () => {
    const w = and(where({ status: 'ON_REQUEST,FAILED', supplier: 'Global Hotel Supply', paymentStatus: 'UNPAID', nonRefundable: 'true', amended: 'true', missingSupplierRef: 'true' }))
    expect(w).toEqual(expect.arrayContaining([{ status: { in: ['ON_REQUEST', 'FAILED'] } }, { supplier: 'Global Hotel Supply' }, { paymentStatus: 'UNPAID' }, { isRefundable: false }, { version: { gt: 1 } }, { status: 'CONFIRMED', supplierRef: null }]))
  })

  it('BK-Q04: one reference box finds the FBEDS reference, supplier reference, hotel confirmation number and the agency reference', () => {
    const [clause] = and(where({ reference: 'fb-a1b2' }))
    expect(clause.OR).toEqual([{ reference: { startsWith: 'FB-A1B2' } }, { supplierRef: { equals: 'fb-a1b2', mode: 'insensitive' } }, { hotelConfirmationNo: { equals: 'fb-a1b2', mode: 'insensitive' } }, { agentRef: { equals: 'fb-a1b2', mode: 'insensitive' } }])
  })

  it('BK-Q05: LIKE metacharacters are matched literally', () => {
    expect(and(where({ reference: 'A_B' }))[0].OR[0]).toEqual({ reference: { startsWith: 'A\\_B' } })
    expect(and(where({ guest: '50%' }, operatorPii))[0].guests.some.OR[0].firstName.contains).toBe('50\\%')
  })

  it('BK-Q06: guest search needs booking.pii.view (searching names would confirm a guest exists to someone who cannot see names)', () => {
    expect(() => parseBookingListQuery({ guest: 'amira' }, operator)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ guest: 'a' }, operatorPii)).toThrow(BadRequestException)
    expect(and(where({ guest: 'amira' }, operatorPii))[0].guests.some.OR).toHaveLength(2)
  })

  it('BK-Q07: an agency-scoped caller is forced to their agency; another agency is refused; Unassigned is operator-only', () => {
    expect(and(where({}, agency))[0]).toEqual({ agencyId: 'ag-1' })
    expect(and(where({ agencyId: 'ag-1' }, agency))[0]).toEqual({ agencyId: 'ag-1' })
    expect(() => parseBookingListQuery({ agencyId: 'ag-2' }, agency)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ agencyId: 'unassigned' }, agency)).toThrow(ForbiddenException)
    expect(and(where({ agencyId: 'ag-2,unassigned' }))[0].OR).toEqual([{ agencyId: { in: ['ag-2'] } }, { agencyId: null }])
    // an agency caller with no agency id can match nothing, never everything
    expect(and(where({}, { ...agency, agencyId: null }))[0]).toEqual({ agencyId: '__none__' })
  })

  it('BK-Q08: date ranges: day columns compare on the day, timestamp columns include the whole last day', () => {
    expect(and(where({ dateType: 'checkIn', from: '2030-07-01', to: '2030-07-05' }))[0]).toEqual({ checkIn: { gte: new Date('2030-07-01T00:00:00Z'), lte: new Date('2030-07-05T00:00:00Z') } })
    expect(and(where({ dateType: 'created', to: '2030-07-05' }))[0]).toEqual({ createdAt: { lte: new Date('2030-07-05T23:59:59.999Z') } })
    expect(parseBookingListQuery({ from: '2030-07-01' }, operator).dateType).toBe('created')
  })

  it('BK-Q09: every quick search has a definition, with the documented meaning', () => {
    const chips = Object.fromEntries(BOOKING_QUICK_SEARCHES.map((chip) => [chip, and(where({ chip }))[0]]))
    expect(Object.keys(chips)).toHaveLength(10)
    expect(chips.latest).toBeUndefined()
    expect(chips.needsAction).toEqual({ closedAt: null, OR: [{ status: { in: ['PENDING_SUPPLIER', 'ON_REQUEST', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'FAILED'] } }, { status: 'CONFIRMED', supplierRef: null }] })
    expect(chips.missingSupplierRef).toEqual({ status: 'CONFIRMED', supplierRef: null })
    expect(chips.onRequest).toEqual({ status: 'ON_REQUEST' })
    expect(chips.failed).toEqual({ status: 'FAILED', closedAt: null })
    expect(chips.latestCancelled).toEqual({ status: 'CANCELLED' })
    expect(chips.unpaid).toEqual({ paymentStatus: { in: ['UNPAID', 'OVERDUE'] } }) // unknown payment (null) is not unpaid
    expect(chips.checkInNext7).toEqual({ status: { notIn: ['CANCELLED', 'FAILED', 'REJECTED'] }, checkIn: { gte: new Date('2030-06-10T00:00:00Z'), lte: new Date('2030-06-17T00:00:00Z') } })
    expect(chips.deadline48h).toEqual({ status: { in: ['CONFIRMED', 'AMEND_REQUESTED'] }, cancelDeadline: { gte: NOW, lte: new Date('2030-06-12T10:30:00Z') } })
    expect(chips.noShowCandidates).toEqual({ status: 'CONFIRMED', checkIn: { gte: new Date('2030-06-03T00:00:00Z'), lte: new Date('2030-06-10T00:00:00Z') } })
  })

  it('BK-Q10: a chip sets a sensible default sort and the caller can override it; nulls sort last and the id breaks ties', () => {
    expect(parseBookingListQuery({ chip: 'checkInNext7' }, operator)).toMatchObject({ sort: 'checkIn', dir: 'asc' })
    expect(parseBookingListQuery({ chip: 'checkInNext7', sort: 'amount', dir: 'desc' }, operator)).toMatchObject({ sort: 'amount', dir: 'desc' })
    expect(buildBookingOrderBy(parseBookingListQuery({ sort: 'deadline', dir: 'asc' }, operator))).toEqual([{ cancelDeadline: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }])
  })

  it('BK-Q11: the resolved hotel set and a direct hotel id both narrow the result', () => {
    expect(and(where({ hotelId: 'h1' }, operator, ['h1', 'h2'])).map((c) => c.hotelId)).toEqual(['h1', { in: ['h1', 'h2'] }])
    expect(and(where({}, operator, []))[0]).toEqual({ hotelId: { in: [] } }) // a hotel text that matched nothing matches no booking
  })

  it('BK-Q12: the applied-filter echo names every filter so an empty state can say what removed everything', () => {
    const f = parseBookingListQuery({ chip: 'onRequest', status: 'ON_REQUEST', hotel: 'atlantis', dateType: 'checkIn', from: '2030-07-01', agencyId: 'unassigned' }, operator)
    expect(describeApplied(f).map((a) => a.key)).toEqual(['chip', 'agencyId', 'hotel', 'status', 'dateType'])
  })

  it('BK-M01: masked names keep one letter per part and never reveal length', () => {
    expect(maskedGuestName('Amira', 'Haddad')).toBe('A••• H•••')
    expect(maskedGuestName('Jo', 'Bartholomew-Smythe')).toBe('J••• B•••')
    expect(guestName('Amira', 'Haddad', false)).toEqual({ name: 'A••• H•••', masked: true })
    expect(guestName(' Amira ', 'Haddad', true)).toEqual({ name: 'Amira Haddad', masked: false })
    expect(maskedGuestName('', '')).toBe('')
  })
})
