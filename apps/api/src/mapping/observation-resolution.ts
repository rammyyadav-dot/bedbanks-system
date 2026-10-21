/**
 * Resolution of ingested supplier observations to canonical identity (ADR 0081). Pure and transport-agnostic: no I/O, no clock besides the `now` it is given.
 *
 * An observation is keyed by supplier codes (ADR 0078). It resolves only through APPROVED (MAPPED) hotel, room and rate plan mappings (ADR 0004, 0081), chained: a rate plan
 * mapping is usable only under a MAPPED room mapping under a MAPPED hotel mapping. Everything else is returned with a stable reason and is never guessed, defaulted or
 * partially resolved. Resolution is advisory: it changes nothing and it does not make an observation sellable.
 */
export type MappingState = 'PENDING' | 'MAPPED' | 'REJECTED'

export interface HotelMappingRow { id: string; supplierHotelId: string; hotelId: string; status: MappingState }
export interface RoomMappingRow { id: string; supplierHotelMappingId: string; supplierRoomId: string; roomTypeId: string; status: MappingState }
export interface RatePlanMappingRow { id: string; supplierRoomMappingId: string; supplierRatePlanCode: string; ratePlanId: string; ratePlanCurrency: string; status: MappingState }

interface PlanEntry { id: string; roomMappingId: string; roomCode: string; ratePlanId: string; currency: string; status: MappingState }
export interface MappingIndex {
  hotels: ReadonlyMap<string, HotelMappingRow>
  rooms: ReadonlyMap<string, RoomMappingRow>
  plans: ReadonlyMap<string, PlanEntry>
  plansByHotelAndCode: ReadonlyMap<string, readonly PlanEntry[]>
}

const SEP = '\u0000'
const key = (...parts: string[]) => parts.join(SEP)

export function buildMappingIndex(hotels: readonly HotelMappingRow[], rooms: readonly RoomMappingRow[], plans: readonly RatePlanMappingRow[]): MappingIndex {
  const hotelMap = new Map(hotels.map((h) => [h.supplierHotelId, h]))
  const roomMap = new Map(rooms.map((r) => [key(r.supplierHotelMappingId, r.supplierRoomId), r]))
  const roomById = new Map(rooms.map((r) => [r.id, r]))
  const planMap = new Map<string, PlanEntry>()
  const byHotel = new Map<string, PlanEntry[]>()
  for (const p of plans) {
    const room = roomById.get(p.supplierRoomMappingId)
    if (!room) continue
    const entry: PlanEntry = { id: p.id, roomMappingId: room.id, roomCode: room.supplierRoomId, ratePlanId: p.ratePlanId, currency: p.ratePlanCurrency, status: p.status }
    planMap.set(key(room.id, p.supplierRatePlanCode), entry)
    const list = byHotel.get(key(room.supplierHotelMappingId, p.supplierRatePlanCode)) ?? []
    list.push(entry)
    byHotel.set(key(room.supplierHotelMappingId, p.supplierRatePlanCode), list)
  }
  return { hotels: hotelMap, rooms: roomMap, plans: planMap, plansByHotelAndCode: byHotel }
}

export type UnresolvedReason =
  | 'HOTEL_UNMAPPED' | 'HOTEL_NOT_APPROVED' | 'ROOM_UNMAPPED' | 'ROOM_NOT_APPROVED' | 'RATE_PLAN_UNMAPPED' | 'RATE_PLAN_NOT_APPROVED'
  | 'CURRENCY_MISMATCH' | 'TAX_BASIS_UNSTATED' | 'STALE'
export type UnresolvedLevel = 'hotel' | 'room' | 'rate_plan' | 'observation'
export type Resolution<T> = { ok: true; target: T } | { ok: false; reason: UnresolvedReason; level: UnresolvedLevel }

const fail = (reason: UnresolvedReason, level: UnresolvedLevel): { ok: false; reason: UnresolvedReason; level: UnresolvedLevel } => ({ ok: false, reason, level })

export interface RateObservationRef { supplierHotelCode: string; supplierRoomCode: string; supplierRatePlanCode: string; currency: string; taxesIncluded: boolean | null; freshUntil: Date }
/** `supplierRatePlanCode` '' means the statement covers every plan of the room. */
export interface AllotmentObservationRef { supplierHotelCode: string; supplierRoomCode: string; supplierRatePlanCode: string; freshUntil: Date }
/** `supplierRoomCode` '' means the policy covers the plan in every room it is mapped under. */
export interface CancellationObservationRef { supplierHotelCode: string; supplierRoomCode: string; supplierRatePlanCode: string; freshUntil: Date }

export interface RateTarget { hotelId: string; roomTypeId: string; ratePlanId: string; hotelMappingId: string; roomMappingId: string; ratePlanMappingId: string }
export interface AllotmentTarget { hotelId: string; roomTypeId: string; roomMappingId: string; /** null: the statement covers every plan of the room; the promotion step fans it out. */ ratePlanId: string | null }
export interface CancellationTarget { hotelId: string; plans: Array<{ roomTypeId: string; ratePlanId: string; roomMappingId: string }> }

function hotelOf(index: MappingIndex, code: string): Resolution<HotelMappingRow> {
  const h = index.hotels.get(code)
  if (!h) return fail('HOTEL_UNMAPPED', 'hotel')
  return h.status === 'MAPPED' ? { ok: true, target: h } : fail('HOTEL_NOT_APPROVED', 'hotel')
}
function roomOf(index: MappingIndex, hotel: HotelMappingRow, code: string): Resolution<RoomMappingRow> {
  const r = index.rooms.get(key(hotel.id, code))
  if (!r) return fail('ROOM_UNMAPPED', 'room')
  return r.status === 'MAPPED' ? { ok: true, target: r } : fail('ROOM_NOT_APPROVED', 'room')
}
const fresh = (until: Date, now: Date) => now.getTime() < until.getTime()

export function resolveRate(o: RateObservationRef, index: MappingIndex, now: Date): Resolution<RateTarget> {
  const hotel = hotelOf(index, o.supplierHotelCode)
  if (!hotel.ok) return hotel
  const room = roomOf(index, hotel.target, o.supplierRoomCode)
  if (!room.ok) return room
  const plan = index.plans.get(key(room.target.id, o.supplierRatePlanCode))
  if (!plan) return fail('RATE_PLAN_UNMAPPED', 'rate_plan')
  if (plan.status !== 'MAPPED') return fail('RATE_PLAN_NOT_APPROVED', 'rate_plan')
  if (o.currency !== plan.currency) return fail('CURRENCY_MISMATCH', 'observation')
  if (o.taxesIncluded === null) return fail('TAX_BASIS_UNSTATED', 'observation')
  if (!fresh(o.freshUntil, now)) return fail('STALE', 'observation')
  return { ok: true, target: { hotelId: hotel.target.hotelId, roomTypeId: room.target.roomTypeId, ratePlanId: plan.ratePlanId, hotelMappingId: hotel.target.id, roomMappingId: room.target.id, ratePlanMappingId: plan.id } }
}

export function resolveAllotment(o: AllotmentObservationRef, index: MappingIndex, now: Date): Resolution<AllotmentTarget> {
  const hotel = hotelOf(index, o.supplierHotelCode)
  if (!hotel.ok) return hotel
  const room = roomOf(index, hotel.target, o.supplierRoomCode)
  if (!room.ok) return room
  let ratePlanId: string | null = null
  if (o.supplierRatePlanCode !== '') {
    const plan = index.plans.get(key(room.target.id, o.supplierRatePlanCode))
    if (!plan) return fail('RATE_PLAN_UNMAPPED', 'rate_plan')
    if (plan.status !== 'MAPPED') return fail('RATE_PLAN_NOT_APPROVED', 'rate_plan')
    ratePlanId = plan.ratePlanId
  }
  if (!fresh(o.freshUntil, now)) return fail('STALE', 'observation')
  return { ok: true, target: { hotelId: hotel.target.hotelId, roomTypeId: room.target.roomTypeId, roomMappingId: room.target.id, ratePlanId } }
}

export function resolveCancellation(o: CancellationObservationRef, index: MappingIndex, now: Date): Resolution<CancellationTarget> {
  const hotel = hotelOf(index, o.supplierHotelCode)
  if (!hotel.ok) return hotel
  const candidates = (index.plansByHotelAndCode.get(key(hotel.target.id, o.supplierRatePlanCode)) ?? []).filter((p) => o.supplierRoomCode === '' || p.roomCode === o.supplierRoomCode)
  if (candidates.length === 0) return fail('RATE_PLAN_UNMAPPED', 'rate_plan')
  // A plan counts only under a MAPPED room mapping; a policy for a plan that is mapped but whose room is not approved does not resolve.
  const usable = candidates.filter((p) => p.status === 'MAPPED' && index.rooms.get(key(hotel.target.id, p.roomCode))?.status === 'MAPPED')
  if (usable.length === 0) return fail('RATE_PLAN_NOT_APPROVED', 'rate_plan')
  if (!fresh(o.freshUntil, now)) return fail('STALE', 'observation')
  return { ok: true, target: { hotelId: hotel.target.hotelId, plans: usable.map((p) => ({ roomTypeId: index.rooms.get(key(hotel.target.id, p.roomCode))!.roomTypeId, ratePlanId: p.ratePlanId, roomMappingId: p.roomMappingId })) } }
}

export interface UnmappedCode { level: Exclude<UnresolvedLevel, 'observation'>; supplierHotelCode: string; supplierRoomCode: string | null; supplierRatePlanCode: string | null; reason: UnresolvedReason; count: number }
export interface ResolutionSummary { resolved: number; unresolved: number; byReason: Partial<Record<UnresolvedReason, number>>; /** Distinct supplier codes that need a person (the mapping review feed), most frequent first, capped. */ unmapped: UnmappedCode[] }

const REVIEW_LIMIT = 200
const NEEDS_PERSON: ReadonlySet<UnresolvedReason> = new Set(['HOTEL_UNMAPPED', 'HOTEL_NOT_APPROVED', 'ROOM_UNMAPPED', 'ROOM_NOT_APPROVED', 'RATE_PLAN_UNMAPPED', 'RATE_PLAN_NOT_APPROVED'])

/** Counts outcomes and collects the distinct codes behind mapping gaps. Currency, tax-basis and staleness outcomes are counted but are not mapping work, so they never enter the review feed. */
export function summarizeResolutions(items: ReadonlyArray<{ hotel: string; room: string | null; plan: string | null; resolution: Resolution<unknown> }>): ResolutionSummary {
  const byReason: Partial<Record<UnresolvedReason, number>> = {}
  const codes = new Map<string, UnmappedCode>()
  let resolved = 0
  for (const item of items) {
    if (item.resolution.ok) { resolved++; continue }
    const { reason, level } = item.resolution
    byReason[reason] = (byReason[reason] ?? 0) + 1
    if (!NEEDS_PERSON.has(reason) || level === 'observation') continue
    const entry: UnmappedCode = { level, supplierHotelCode: item.hotel, supplierRoomCode: level === 'hotel' ? null : item.room, supplierRatePlanCode: level === 'rate_plan' ? item.plan : null, reason, count: 0 }
    const k = key(level, entry.supplierHotelCode, entry.supplierRoomCode ?? '', entry.supplierRatePlanCode ?? '', reason)
    const existing = codes.get(k) ?? entry
    existing.count++
    codes.set(k, existing)
  }
  const unmapped = [...codes.values()].sort((a, b) => b.count - a.count || a.supplierHotelCode.localeCompare(b.supplierHotelCode)).slice(0, REVIEW_LIMIT)
  return { resolved, unresolved: items.length - resolved, byReason, unmapped }
}
