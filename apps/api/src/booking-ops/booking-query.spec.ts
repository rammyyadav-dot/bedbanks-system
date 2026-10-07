import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { BOOKING_QUERY_FIELDS, bookingQueryKey, bookingQueryToParams, normalizeBookingQuery, type BookingAccessView, type BookingQueryV1 } from '@bedbanks/contracts'
import { buildBookingOrderBy, buildBookingWhere, parseBookingListQuery } from './booking-list-query'

const NOW = new Date('2030-06-10T10:30:00.000Z')
const base: BookingAccessView = { level: 'OPERATOR', canViewNet: false, canViewPii: false, agencyId: null, permissions: [], manualEntry: false, supplierDispatch: false, opsQueue: false }
const full: BookingAccessView = { ...base, canViewPii: true, permissions: ['booking.finance.view', 'booking.ops.view'] }
const agency: BookingAccessView = { ...base, level: 'AGENCY', agencyId: 'ag-1' }
const ok = (raw: Record<string, unknown>) => { const r = normalizeBookingQuery(raw); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r }
const and = (raw: Record<string, unknown>, access = full) => (buildBookingWhere(parseBookingListQuery(raw, access), { tenantId: 't1', access }, null, NOW) as { AND?: Array<Record<string, any>> }).AND ?? []

describe('BookingQueryV1: the canonical booking-query grammar (ADR 0039, Phase 6A)', () => {
  it('BQ-01: equal queries normalize to one object and one key, whatever the order, duplicates, spacing or defaults in the input', () => {
    const a = ok({ status: 'FAILED, CONFIRMED,FAILED', agencyId: 'b2,a1,unassigned,a1', supplier: ' Global Hotel Supply ', dateType: 'created', from: '2030-01-01', nonRefundable: 'true', missingSupplierRef: 'false' })
    const b = ok({ missingSupplierRef: '', nonRefundable: true, from: '2030-01-01', supplier: 'Global Hotel Supply', agencyId: 'unassigned,a1,b2', status: 'CONFIRMED,FAILED' })
    expect(a.query).toEqual(b.query)
    expect(bookingQueryKey(a.query)).toBe(bookingQueryKey(b.query))
    expect(a.query.statuses).toEqual(['CONFIRMED', 'FAILED']) // lifecycle order, unique
    expect(a.query.agencyIds).toEqual(['a1', 'b2', 'unassigned'])
  })

  it('BQ-02: normalizing the canonical parameters again returns the same query (stable under round trips and saved views)', () => {
    const first = ok({ chip: 'deadline48h', hotel: 'atlantis', destination: 'Dubai', source: 'MANUAL', currency: 'AED', amountMin: '1000', amountMax: '90000', moneyEvent: 'CANCELLED', opsOwner: 'unassigned', dateType: 'updated', from: '2030-02-01', to: '2030-02-28', sort: 'amount', dir: 'asc' })
    const params = bookingQueryToParams(first.query)
    const second = ok(params)
    expect(second.query).toEqual(first.query)
    expect(bookingQueryToParams(second.query)).toEqual(params)
  })

  it('BQ-03: a date type with no range is dropped; with a range it defaults to created; sort and direction follow the chip unless chosen', () => {
    expect(ok({ dateType: 'checkIn' }).query.dateType).toBeNull()
    expect(ok({ from: '2030-01-01' }).query.dateType).toBe('created')
    expect(ok({ chip: 'checkInNext7' }).query).toMatchObject({ sort: 'checkIn', dir: 'asc' })
    expect(ok({ chip: 'checkInNext7', sort: 'amount', dir: 'desc' }).query).toMatchObject({ sort: 'amount', dir: 'desc' })
    expect(bookingQueryToParams(ok({ chip: 'checkInNext7' }).query)).toEqual({ chip: 'checkInNext7' }) // chip defaults are not repeated
    expect(bookingQueryToParams(ok({ chip: 'checkInNext7', sort: 'amount' }).query)).toEqual({ chip: 'checkInNext7', sort: 'amount' })
  })

  it('BQ-04: an unsupported field is rejected, not ignored (a typo or a newer client never silently widens a query)', () => {
    const r = normalizeBookingQuery({ status: 'CONFIRMED', tenantId: 'someone-else', where: '1=1', agencyID: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.filter((i) => i.code === 'UNSUPPORTED_FIELD').map((i) => i.field).sort()).toEqual(['agencyID', 'tenantId', 'where'])
    expect(() => parseBookingListQuery({ tenantId: 'x' }, base)).toThrow(BadRequestException)
    for (const key of ['tenantId', 'tenant_id', 'userId', 'actor', 'permissions', 'where', 'orderBy', 'sql']) expect((BOOKING_QUERY_FIELDS as readonly string[]).includes(key)).toBe(false)
  })

  it('BQ-05: malformed values are rejected, and every problem is reported at once', () => {
    const r = normalizeBookingQuery({ status: 'NOPE', from: '2030-02-31', to: 'tomorrow', page: '0', pageSize: '30', hotelId: 'a b', currency: 'aed', agencyId: 'x'.repeat(100), supplier: 'a\u0000b' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.field).sort()).toEqual(['agencyId', 'currency', 'from', 'hotelId', 'page', 'pageSize', 'status', 'supplier', 'to'])
    for (const raw of [{ status: ['CONFIRMED'] }, { reference: { $ne: 1 } }, { chip: 'everything' }, { sort: 'name' }, { dir: 'sideways' }, { missingSupplierRef: 'yes' }, { amended: '1' }]) expect(normalizeBookingQuery(raw as never).ok).toBe(false)
    expect(normalizeBookingQuery(null as never).ok).toBe(false)
    expect(normalizeBookingQuery([] as never).ok).toBe(false)
  })

  it('BQ-06: incompatible combinations are rejected: reversed dates, an amount range without a currency, min above max', () => {
    expect(normalizeBookingQuery({ from: '2030-03-02', to: '2030-03-01' })).toMatchObject({ ok: false })
    expect(normalizeBookingQuery({ amountMin: '100' })).toMatchObject({ ok: false, issues: [expect.objectContaining({ field: 'currency', code: 'INCOMPATIBLE' })] })
    expect(normalizeBookingQuery({ currency: 'AED', amountMin: '500', amountMax: '100' })).toMatchObject({ ok: false })
    expect(normalizeBookingQuery({ currency: 'AED', amountMin: '1.5' })).toMatchObject({ ok: false }) // minor units, no decimals, no float
    expect(normalizeBookingQuery({ currency: 'AED', amountMin: '100', amountMax: '100' })).toMatchObject({ ok: true })
    expect(normalizeBookingQuery({ currency: 'AED', amountMin: '999999999999998', amountMax: '999999999999999' })).toMatchObject({ ok: true }) // 15 digits: the largest accepted size
    expect(normalizeBookingQuery({ currency: 'AED', amountMin: '1000000000000000' })).toMatchObject({ ok: false }) // 16 digits: refused, never a float
  })

  it('BQ-07: paging is validated separately from the query and never part of its identity', () => {
    const a = ok({ status: 'FAILED', page: '3', pageSize: '50' }); const b = ok({ status: 'FAILED' })
    expect(a.page).toEqual({ page: 3, pageSize: 50 }); expect(b.page).toEqual({ page: 1, pageSize: 25 })
    expect(bookingQueryKey(a.query)).toBe(bookingQueryKey(b.query))
    expect(bookingQueryToParams(a.query)).not.toHaveProperty('page')
  })

  it('BQ-08: sorting is deterministic: the id breaks every tie, nulls sort last in both directions', () => {
    for (const sort of ['created', 'checkIn', 'checkOut', 'deadline', 'amount'] as const) for (const dir of ['asc', 'desc'] as const) {
      const order = buildBookingOrderBy(parseBookingListQuery({ sort, dir }, base))
      expect(order).toHaveLength(2); expect(order[1]).toEqual({ id: 'desc' })
    }
    expect(buildBookingOrderBy(parseBookingListQuery({ sort: 'checkIn', dir: 'asc' }, base))[0]).toEqual({ checkIn: { sort: 'asc', nulls: 'last' } })
  })

  it('BQ-09: fields that depend on what the caller may see are refused to a caller who may not see them', () => {
    for (const raw of [{ guest: 'Haddad' }]) expect(() => parseBookingListQuery(raw, base)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ moneyEvent: 'CANCELLED' }, base)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ opsOwner: 'u1' }, base)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ moneyEvent: 'CANCELLED', opsOwner: 'u1', guest: 'Haddad' }, full)).not.toThrow()
    expect(() => parseBookingListQuery({ moneyEvent: 'CANCELLED' }, agency)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ opsOwner: 'unassigned' }, agency)).toThrow(ForbiddenException)
    expect(() => parseBookingListQuery({ agencyId: 'other' }, agency)).toThrow(ForbiddenException)
  })

  it('BQ-10: an agency caller is always scoped to their own agency, whatever the query says', () => {
    const where = buildBookingWhere(parseBookingListQuery({ status: 'CONFIRMED' }, agency), { tenantId: 't1', access: agency }, null, NOW) as { tenantId: string; AND: Array<Record<string, unknown>> }
    expect(where.tenantId).toBe('t1')
    expect(where.AND).toContainEqual({ agencyId: 'ag-1' })
  })

  it('BQ-11: the new fields build the intended clauses, with amounts as bigint minor units', () => {
    const clauses = and({ source: 'MANUAL', currency: 'AED', amountMin: '1000', amountMax: '90000', opsOwner: 'u1', moneyEvent: 'CANCELLED', dateType: 'updated', from: '2030-02-01', to: '2030-02-02' })
    expect(clauses).toEqual(expect.arrayContaining([
      { channel: 'MANUAL' }, { currency: 'AED' }, { totalMinor: { gte: 1000n, lte: 90000n } },
      { opsState: { is: { assigneeUserId: 'u1' } } }, { financeEvents: { some: { type: 'CANCELLED' } } },
    ]))
    expect(clauses.find((c) => c.updatedAt)?.updatedAt).toEqual({ gte: new Date('2030-02-01T00:00:00.000Z'), lte: new Date('2030-02-02T23:59:59.999Z') })
    expect(and({ opsOwner: 'unassigned' })[0]).toEqual({ OR: [{ opsState: { is: null } }, { opsState: { is: { assigneeUserId: null } } }] })
  })

  it('BQ-12: the filters never carry a tenant, an actor or a permission', () => {
    const q: BookingQueryV1 = ok({ status: 'CONFIRMED', hotel: 'atlantis' }).query
    expect(JSON.stringify(q)).not.toMatch(/tenant|user|permission|actor/i)
    expect(JSON.stringify(bookingQueryToParams(q))).not.toMatch(/tenant|user|permission|actor/i)
  })
})
