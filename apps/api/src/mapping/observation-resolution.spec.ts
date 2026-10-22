import { buildMappingIndex, resolveAllotment, resolveCancellation, resolveRate, summarizeResolutions, type MappingState } from './observation-resolution'

const now = new Date('2027-01-10T10:00:00.000Z')
const later = new Date('2027-01-10T11:00:00.000Z')
const earlier = new Date('2027-01-10T09:00:00.000Z')
const hotel = (status: MappingState = 'MAPPED') => ({ id: 'hm1', supplierHotelId: 'H1', hotelId: 'hotel-1', status })
const room = (supplierRoomId: string, status: MappingState = 'MAPPED', id = `rm-${supplierRoomId}`) => ({ id, supplierHotelMappingId: 'hm1', supplierRoomId, roomTypeId: `rt-${supplierRoomId}`, status })
const plan = (roomMappingId: string, code: string, status: MappingState = 'MAPPED', currency = 'AED') => ({ id: `pm-${roomMappingId}-${code}`, supplierRoomMappingId: roomMappingId, supplierRatePlanCode: code, ratePlanId: `rp-${roomMappingId}-${code}`, ratePlanCurrency: currency, status })
const rate = (patch: object = {}) => ({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: 'BAR', currency: 'AED', taxesIncluded: true as boolean | null, freshUntil: later, ...patch })

describe('observation resolution (ADR 0081)', () => {
  const index = buildMappingIndex([hotel()], [room('DBL'), room('TWN')], [plan('rm-DBL', 'BAR'), plan('rm-TWN', 'BAR')])

  it('resolves a rate only through MAPPED hotel, room and rate plan mappings', () => {
    expect(resolveRate(rate(), index, now)).toEqual({ ok: true, target: { hotelId: 'hotel-1', roomTypeId: 'rt-DBL', ratePlanId: 'rp-rm-DBL-BAR', hotelMappingId: 'hm1', roomMappingId: 'rm-DBL', ratePlanMappingId: 'pm-rm-DBL-BAR' } })
  })

  it('reports the first missing link with a stable reason and level, never a partial resolution', () => {
    const r = (o: object, idx = index) => resolveRate(rate(o), idx, now)
    expect(r({ supplierHotelCode: 'X' })).toEqual({ ok: false, reason: 'HOTEL_UNMAPPED', level: 'hotel' })
    expect(r({ supplierRoomCode: 'X' })).toEqual({ ok: false, reason: 'ROOM_UNMAPPED', level: 'room' })
    expect(r({ supplierRatePlanCode: 'X' })).toEqual({ ok: false, reason: 'RATE_PLAN_UNMAPPED', level: 'rate_plan' })
    for (const status of ['PENDING', 'REJECTED'] as const) {
      expect(r({}, buildMappingIndex([hotel(status)], [room('DBL')], [plan('rm-DBL', 'BAR')]))).toMatchObject({ reason: 'HOTEL_NOT_APPROVED' })
      expect(r({}, buildMappingIndex([hotel()], [room('DBL', status)], [plan('rm-DBL', 'BAR')]))).toMatchObject({ reason: 'ROOM_NOT_APPROVED' })
      expect(r({}, buildMappingIndex([hotel()], [room('DBL')], [plan('rm-DBL', 'BAR', status)]))).toMatchObject({ reason: 'RATE_PLAN_NOT_APPROVED' })
    }
  })

  it('blocks a currency mismatch, an unstated tax basis and a stale observation (the instant of expiry is stale)', () => {
    expect(resolveRate(rate({ currency: 'USD' }), index, now)).toMatchObject({ ok: false, reason: 'CURRENCY_MISMATCH' })
    expect(resolveRate(rate({ taxesIncluded: null }), index, now)).toMatchObject({ ok: false, reason: 'TAX_BASIS_UNSTATED' })
    expect(resolveRate(rate({ freshUntil: earlier }), index, now)).toMatchObject({ ok: false, reason: 'STALE' })
    expect(resolveRate(rate({ freshUntil: now }), index, now)).toMatchObject({ ok: false, reason: 'STALE' })
  })

  it('an unmapped code is reported as unmapped even when the observation is also stale', () => {
    expect(resolveRate(rate({ supplierRoomCode: 'X', freshUntil: earlier }), index, now)).toMatchObject({ reason: 'ROOM_UNMAPPED' })
  })

  it('allotments resolve to the room, or to a plan; a room-wide statement leaves the plan null', () => {
    const a = (patch: object) => resolveAllotment({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: '', freshUntil: later, ...patch }, index, now)
    expect(a({})).toEqual({ ok: true, target: { hotelId: 'hotel-1', roomTypeId: 'rt-DBL', roomMappingId: 'rm-DBL', ratePlanId: null } })
    expect(a({ supplierRatePlanCode: 'BAR' })).toMatchObject({ ok: true, target: { ratePlanId: 'rp-rm-DBL-BAR' } })
    expect(a({ supplierRatePlanCode: 'NOPE' })).toMatchObject({ reason: 'RATE_PLAN_UNMAPPED' })
    expect(a({ freshUntil: earlier })).toMatchObject({ reason: 'STALE' })
  })

  it('a cancellation policy resolves to every approved plan with that code, or to the one room it names', () => {
    const c = (patch: object, idx = index) => resolveCancellation({ supplierHotelCode: 'H1', supplierRoomCode: '', supplierRatePlanCode: 'BAR', freshUntil: later, ...patch }, idx, now)
    const all = c({})
    expect(all.ok && all.target.plans.map((p) => p.ratePlanId).sort()).toEqual(['rp-rm-DBL-BAR', 'rp-rm-TWN-BAR'])
    const one = c({ supplierRoomCode: 'TWN' })
    expect(one.ok && one.target.plans.map((p) => p.ratePlanId)).toEqual(['rp-rm-TWN-BAR'])
    expect(c({ supplierRatePlanCode: 'NOPE' })).toMatchObject({ reason: 'RATE_PLAN_UNMAPPED' })
    // A mapped plan under a room that is not approved does not count; a pending sibling is ignored while an approved one resolves.
    const mixed = buildMappingIndex([hotel()], [room('DBL', 'PENDING'), room('TWN')], [plan('rm-DBL', 'BAR'), plan('rm-TWN', 'BAR')])
    const m = c({}, mixed)
    expect(m.ok && m.target.plans.map((p) => p.ratePlanId)).toEqual(['rp-rm-TWN-BAR'])
    expect(c({ supplierRoomCode: 'DBL' }, mixed)).toMatchObject({ reason: 'RATE_PLAN_NOT_APPROVED' })
    expect(c({ freshUntil: now })).toMatchObject({ reason: 'STALE' })
  })

  it('summarizes outcomes and lists only mapping gaps in the review feed, most frequent first', () => {
    const rows = [
      rate(), rate({ supplierRoomCode: 'X' }), rate({ supplierRoomCode: 'X' }), rate({ supplierHotelCode: 'Z' }), rate({ supplierRatePlanCode: 'P9' }), rate({ currency: 'USD' }), rate({ freshUntil: earlier }),
    ].map((o) => ({ hotel: o.supplierHotelCode, room: o.supplierRoomCode, plan: o.supplierRatePlanCode, resolution: resolveRate(o, index, now) }))
    const s = summarizeResolutions(rows)
    expect(s).toMatchObject({ resolved: 1, unresolved: 6, byReason: { ROOM_UNMAPPED: 2, HOTEL_UNMAPPED: 1, RATE_PLAN_UNMAPPED: 1, CURRENCY_MISMATCH: 1, STALE: 1 } })
    expect(s.unmapped[0]).toEqual({ level: 'room', supplierHotelCode: 'H1', supplierRoomCode: 'X', supplierRatePlanCode: null, reason: 'ROOM_UNMAPPED', count: 2 })
    expect(s.unmapped.map((u) => u.level).sort()).toEqual(['hotel', 'rate_plan', 'room'])
    expect(s.unmapped.some((u) => u.reason === 'STALE' || u.reason === 'CURRENCY_MISMATCH')).toBe(false)
  })
})
