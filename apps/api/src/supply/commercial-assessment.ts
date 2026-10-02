import {
  CONTRACT_EXPIRING_DAYS, HOTEL_STAR_RATING_MISSING,
  type CommercialIssue, type CommercialIssueCategory, type CommercialReadiness, type ContractState, type GateState, type HotelSection,
  type InventoryState, type IssueSeverity, type MappingState, type ReadinessGate, type SupplyDataState,
} from '@bedbanks/contracts'
import { evaluateContractedStay } from './contracted-sellability'
import { buildStaySnapshot, type StayPlanInput } from './stay-snapshot'

/**
 * Pure commercial assessment of one hotel over a window of nights. It owns no I/O and reads no clock: `today` is injected, so tests
 * are deterministic. Every sellability decision comes from `evaluateContractedStay`, the evaluator the Agent search uses.
 *
 * A night is assessed as a one-night stay for the plan's own occupancy. Stay-length rules (min/max stay, release days,
 * closed-to-arrival) depend on the requested stay, not on the night, so they are excluded here and reported by the stay-level
 * Sellability Inspector instead.
 */
const NIGHT_MS = 86_400_000
const STAY_CONTEXT_REASONS = new Set(['MIN_STAY_NOT_MET', 'MAX_STAY_EXCEEDED', 'RELEASE_DAYS_NOT_MET', 'CLOSED_TO_ARRIVAL'])
const HOTEL_LEVEL_REASONS = new Set(['HOTEL_INACTIVE', HOTEL_STAR_RATING_MISSING])

export const addDays = (day: string, count: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * NIGHT_MS).toISOString().slice(0, 10)
export const windowDates = (from: string, days: number): string[] => Array.from({ length: days }, (_, index) => addDays(from, index))
const dayOf = (value: Date): string => value.toISOString().slice(0, 10)

// ---- input ---------------------------------------------------------------------------------------------------------------
export interface AssessMappingRow { id: string; supplierId: string; supplierName: string; hotelId: string; status: string; supplierHotelId: string; confidence: number | null; updatedAt: Date }
export interface AssessRoomMappingRow { id: string; supplierHotelMappingId: string; roomTypeId: string; supplierRoomId: string; status: string; confidence: number | null; updatedAt: Date }
export interface AssessRoom { id: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; isActive: boolean }
export interface AssessPlan extends StayPlanInput {
  /** Rates for every occupancy loaded in the window; assessment keeps only rows matching the plan's own occupancy. */
  dailyRates: Array<StayPlanInput['dailyRates'][number] & { occupancy: number }>
  id: string; code: string; contractId: string; roomTypeId: string; boardBasisId: string; refundable: boolean
  boardBasis: { code: string; isActive: boolean }
  roomType: StayPlanInput['roomType'] & { id: string; name: string; code: string }
  contract: StayPlanInput['contract'] & { id: string; code: string; supplierId: string; supplierHotelMappingId: string | null; supplier: { status: string; displayName: string } }
}
export interface AssessContract { id: string; code: string; status: string; validFrom: Date; validTo: Date; supplierId: string; supplierName: string; supplierStatus: string; supplierHotelMappingId: string | null }
export interface AssessHotelInput {
  hotel: { id: string; name: string; contentStatus: string; starRating: number | null }
  rooms: AssessRoom[]
  plans: AssessPlan[]
  /** Contracts linked to the hotel through a mapping, in addition to those reached through its rate plans. */
  contracts: AssessContract[]
  mappings: AssessMappingRow[]
  roomMappings: AssessRoomMappingRow[]
  dates: string[]
  today: string
  observedAt: string
}

// ---- output --------------------------------------------------------------------------------------------------------------
export interface NightAssessment {
  date: string; reasons: string[]; sellable: boolean
  hasRate: boolean; hasAvailability: boolean; remaining: number | null; stopSell: boolean
}
export interface PlanAssessment {
  plan: AssessPlan
  nights: NightAssessment[]
  counts: { nights: number; sellable: number; rateMissing: number; availabilityMissing: number; stopSell: number; exhausted: number; blockedOther: number }
  amountBasis: 'SELL' | 'NET' | 'UNVERIFIED' | 'MIXED' | 'NONE'
  readiness: CommercialReadiness
  hotelMappingOk: boolean
}
export interface RoomAssessment {
  room: AssessRoom
  mapping: MappingState
  supplierRoomIds: string[]
  plans: PlanAssessment[]
  activePlans: number
  inventory: InventoryState
  readiness: CommercialReadiness
  blockers: string[]
}
export interface HotelAssessment {
  readiness: CommercialReadiness
  agentSellable: boolean
  blockers: string[]
  contractState: ContractState
  contractDaysToExpiry: number | null
  hotelMapping: MappingState
  suppliers: Array<{ id: string; displayName: string }>
  rooms: RoomAssessment[]
  plans: PlanAssessment[]
  rates: SupplyDataState
  inventory: InventoryState
  gates: ReadinessGate[]
  issues: CommercialIssue[]
  roomCounts: { total: number; active: number; mapped: number }
  planCounts: { total: number; active: number }
}

// ---- contract state ------------------------------------------------------------------------------------------------------
export function daysUntil(day: Date, today: string): number {
  return Math.floor((Date.parse(`${dayOf(day)}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / NIGHT_MS)
}

/** The one definition of ACTIVE / EXPIRING / EXPIRED / INACTIVE for a contract. */
export function contractStateOf(contract: { status: string; validTo: Date }, today: string): { state: ContractState; daysToExpiry: number } {
  const daysToExpiry = daysUntil(contract.validTo, today)
  if (contract.status === 'EXPIRED') return { state: 'EXPIRED', daysToExpiry }
  if (contract.status !== 'ACTIVE') return { state: 'INACTIVE', daysToExpiry }
  if (daysToExpiry < 0) return { state: 'EXPIRED', daysToExpiry }
  if (daysToExpiry <= CONTRACT_EXPIRING_DAYS) return { state: 'EXPIRING', daysToExpiry }
  return { state: 'ACTIVE', daysToExpiry }
}
const CONTRACT_RANK: Record<ContractState, number> = { ACTIVE: 0, EXPIRING: 1, INACTIVE: 2, EXPIRED: 3, NONE: 4 }

// ---- night evaluation ----------------------------------------------------------------------------------------------------
export function starRatingValid(starRating: number | null): boolean { return starRating !== null && starRating >= 1 && starRating <= 5 }

/** Splits a plan's guests the way the evaluator expects, preferring adults. */
export function occupancySplit(plan: { occupancy: number; roomType: { maxAdults: number } }) {
  const adults = Math.min(plan.occupancy, plan.roomType.maxAdults)
  return { adults, children: plan.occupancy - adults }
}

export function evaluatePlanNight(plan: AssessPlan, mapping: { status: string; hotelId: string } | null, roomMapping: { status: string } | null, date: string, hotelStarRating: number | null, guests?: { adults: number; children: number; rooms?: number }): string[] {
  const snapshot = buildStaySnapshot(plan, mapping, roomMapping, [date])
  const { adults, children } = guests ?? occupancySplit(plan)
  const decision = evaluateContractedStay(snapshot, { checkIn: date, checkOut: addDays(date, 1), rooms: guests?.rooms ?? 1, adults, children, currency: plan.currency, leadDays: Number.MAX_SAFE_INTEGER })
  const reasons = decision.reasons.filter((reason) => !STAY_CONTEXT_REASONS.has(reason))
  if (!starRatingValid(hotelStarRating)) reasons.push(HOTEL_STAR_RATING_MISSING)
  return reasons
}

export function mappingFor(plan: AssessPlan, input: Pick<AssessHotelInput, 'mappings' | 'roomMappings'>) {
  const mapping = plan.contract.supplierHotelMappingId ? input.mappings.find((row) => row.id === plan.contract.supplierHotelMappingId) ?? null : null
  const roomMapping = mapping ? input.roomMappings.find((row) => row.supplierHotelMappingId === mapping.id && row.roomTypeId === plan.roomTypeId) ?? null : null
  return { mapping, roomMapping }
}

function assessPlan(loaded: AssessPlan, input: AssessHotelInput): PlanAssessment {
  // Only rates for the plan's own occupancy price this plan (the Agent loads exactly these).
  const plan: AssessPlan = { ...loaded, dailyRates: loaded.dailyRates.filter((rate) => rate.occupancy === loaded.occupancy) }
  const { mapping, roomMapping } = mappingFor(plan, input)
  const rates = new Map(plan.dailyRates.map((rate) => [dayOf(rate.stayDate), rate]))
  const availability = new Map(plan.availability.map((row) => [dayOf(row.stayDate), row]))
  const nights: NightAssessment[] = input.dates.map((date) => {
    const reasons = evaluatePlanNight(plan, mapping, roomMapping, date, input.hotel.starRating)
    const row = availability.get(date)
    return { date, reasons, sellable: reasons.length === 0, hasRate: rates.has(date), hasAvailability: Boolean(row), remaining: row ? row.allotment - row.sold - row.held : null, stopSell: row?.stopSell === true }
  })
  const counts = { nights: nights.length, sellable: 0, rateMissing: 0, availabilityMissing: 0, stopSell: 0, exhausted: 0, blockedOther: 0 }
  for (const night of nights) {
    if (night.sellable) counts.sellable += 1
    if (night.reasons.includes('DAILY_RATE_MISSING_OR_INVALID')) counts.rateMissing += 1
    if (night.reasons.includes('AVAILABILITY_MISSING')) counts.availabilityMissing += 1
    if (night.reasons.includes('STOP_SELL')) counts.stopSell += 1
    if (night.reasons.includes('NO_INVENTORY')) counts.exhausted += 1
    if (!night.sellable && !night.reasons.some((r) => ['DAILY_RATE_MISSING_OR_INVALID', 'AVAILABILITY_MISSING', 'STOP_SELL', 'NO_INVENTORY'].includes(r))) counts.blockedOther += 1
  }
  const bases = new Set([...rates.values()].map((rate) => rate.amountBasis ?? 'UNVERIFIED'))
  const amountBasis = bases.size === 0 ? 'NONE' : bases.size > 1 ? 'MIXED' : ([...bases][0] as 'SELL' | 'NET' | 'UNVERIFIED')
  return { plan, nights, counts, amountBasis, readiness: readinessOf(counts.sellable, counts.nights), hotelMappingOk: mapping?.status === 'MAPPED' && mapping.hotelId === plan.roomType.hotelId }
}

function readinessOf(sellable: number, total: number): CommercialReadiness {
  if (total === 0 || sellable === 0) return 'BLOCKED'
  return sellable === total ? 'READY' : 'PARTIAL'
}

function topReasons(reasonCounts: Map<string, number>, limit = 5): string[] {
  return [...reasonCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([reason]) => reason)
}

function mappingStateOf(statuses: string[]): MappingState {
  if (statuses.includes('MAPPED')) return 'MAPPED'
  if (statuses.includes('PENDING')) return 'PENDING'
  if (statuses.includes('REJECTED')) return 'REJECTED'
  return 'NONE'
}

function inventoryStateOf(plans: PlanAssessment[]): InventoryState {
  if (plans.length === 0) return 'NONE'
  const sum = (key: 'availabilityMissing' | 'stopSell' | 'exhausted') => plans.reduce((total, plan) => total + plan.counts[key], 0)
  if (sum('availabilityMissing') > 0) return 'GAPS'
  if (sum('stopSell') > 0) return 'STOP_SELL'
  if (sum('exhausted') > 0) return 'EXHAUSTED'
  return 'OK'
}

// ---- reason classification -----------------------------------------------------------------------------------------------
interface ReasonContext { hotelMappingOk: boolean; contractStatus: string; hasRate: boolean }
export function categoryOfReason(reason: string, context: ReasonContext): CommercialIssueCategory {
  switch (reason) {
    case 'HOTEL_INACTIVE': case HOTEL_STAR_RATING_MISSING: return 'HOTEL_CONTENT'
    case 'ROOM_TYPE_INACTIVE': case 'BOARD_BASIS_INACTIVE': case 'SUPPLIER_INACTIVE': case 'RATE_PLAN_INACTIVE': case 'RATE_PLAN_MISSING': return 'ENTITY_INACTIVE'
    case 'CONTRACT_INACTIVE': return context.contractStatus === 'EXPIRED' ? 'CONTRACT_EXPIRED' : 'ENTITY_INACTIVE'
    case 'OUTSIDE_CONTRACT_VALIDITY': return 'CONTRACT_EXPIRED'
    case 'SUPPLIER_MAPPING_INVALID': return context.hotelMappingOk ? 'UNMAPPED_ROOM' : 'UNMAPPED_HOTEL'
    case 'OCCUPANCY_UNSUPPORTED': return 'OCCUPANCY_UNSUPPORTED'
    case 'DAILY_RATE_MISSING_OR_INVALID': return context.hasRate ? 'RATE_INVALID' : 'RATE_MISSING'
    case 'RATE_CURRENCY_MISMATCH': case 'RATE_AMOUNT_BASIS_UNVERIFIED': case 'NET_RATE_MARKUP_UNAVAILABLE': return 'CURRENCY_OR_BASIS'
    case 'AVAILABILITY_MISSING': return 'AVAILABILITY_MISSING'
    case 'STOP_SELL': return 'STOP_SELL'
    case 'NO_INVENTORY': return 'INVENTORY_EXHAUSTED'
    default: return 'ENTITY_INACTIVE'
  }
}
const SECTION_OF_CATEGORY: Record<CommercialIssueCategory, HotelSection> = {
  UNMAPPED_HOTEL: 'mappings', UNMAPPED_ROOM: 'mappings', CONTRACT_EXPIRED: 'contracts', CONTRACT_EXPIRING: 'contracts', RATE_MISSING: 'rates', RATE_INVALID: 'rates',
  AVAILABILITY_MISSING: 'rates', STOP_SELL: 'rates', INVENTORY_EXHAUSTED: 'rates', OCCUPANCY_UNSUPPORTED: 'rooms', CURRENCY_OR_BASIS: 'rates', ENTITY_INACTIVE: 'overview', HOTEL_CONTENT: 'overview',
}
export const REASON_TEXT: Record<string, string> = {
  HOTEL_INACTIVE: 'Hotel content is not COMPLETE', [HOTEL_STAR_RATING_MISSING]: 'Hotel has no 1-5 star rating, so Agents cannot list it',
  ROOM_TYPE_INACTIVE: 'Room type is inactive', BOARD_BASIS_INACTIVE: 'Board basis is inactive', SUPPLIER_INACTIVE: 'Supplier is not ACTIVE', RATE_PLAN_INACTIVE: 'Rate plan is not ACTIVE',
  RATE_PLAN_MISSING: 'No rate plan is configured', CONTRACT_INACTIVE: 'Contract is not ACTIVE', OUTSIDE_CONTRACT_VALIDITY: 'Date is outside the contract validity',
  SUPPLIER_MAPPING_INVALID: 'Supplier mapping is missing or not approved', OCCUPANCY_UNSUPPORTED: 'Rate plan occupancy exceeds what the room supports',
  DAILY_RATE_MISSING_OR_INVALID: 'Daily rate is missing or invalid', RATE_CURRENCY_MISMATCH: 'Rate currency differs from the plan or contract currency',
  RATE_AMOUNT_BASIS_UNVERIFIED: 'Rate amount basis is not verified', NET_RATE_MARKUP_UNAVAILABLE: 'Net rate has no markup rule, so no sell price exists',
  AVAILABILITY_MISSING: 'No availability row is loaded', STOP_SELL: 'Stop-sell is active', NO_INVENTORY: 'No inventory remains (allotment - sold - held = 0)',
  MIN_STAY_NOT_MET: 'Minimum stay is not met', MAX_STAY_EXCEEDED: 'Maximum stay is exceeded', RELEASE_DAYS_NOT_MET: 'Inside the release period', CLOSED_TO_ARRIVAL: 'Closed to arrival on the check-in date',
}

// ---- gates ---------------------------------------------------------------------------------------------------------------
/** Maps a set of canonical reasons onto the readable gate checklist used by the inspector. */
export const SELLABILITY_GATES: Array<{ key: string; label: string; reasons: string[] }> = [
  { key: 'hotel', label: 'Hotel', reasons: ['HOTEL_INACTIVE', HOTEL_STAR_RATING_MISSING] },
  { key: 'supplier', label: 'Supplier', reasons: ['SUPPLIER_INACTIVE'] },
  { key: 'mapping', label: 'Hotel / room mapping', reasons: ['SUPPLIER_MAPPING_INVALID'] },
  { key: 'room', label: 'Room', reasons: ['ROOM_TYPE_INACTIVE', 'BOARD_BASIS_INACTIVE'] },
  { key: 'contract', label: 'Contract', reasons: ['CONTRACT_INACTIVE', 'OUTSIDE_CONTRACT_VALIDITY'] },
  { key: 'plan', label: 'Rate plan', reasons: ['RATE_PLAN_INACTIVE', 'RATE_PLAN_MISSING'] },
  { key: 'rate', label: 'Daily rate', reasons: ['DAILY_RATE_MISSING_OR_INVALID', 'RATE_CURRENCY_MISMATCH', 'RATE_AMOUNT_BASIS_UNVERIFIED', 'NET_RATE_MARKUP_UNAVAILABLE'] },
  { key: 'availability', label: 'Availability', reasons: ['AVAILABILITY_MISSING'] },
  { key: 'stopSell', label: 'Stop sell', reasons: ['STOP_SELL', 'CLOSED_TO_ARRIVAL'] },
  { key: 'inventory', label: 'Inventory', reasons: ['NO_INVENTORY'] },
  { key: 'occupancy', label: 'Occupancy', reasons: ['OCCUPANCY_UNSUPPORTED'] },
  { key: 'stay', label: 'Stay rules', reasons: ['MIN_STAY_NOT_MET', 'MAX_STAY_EXCEEDED', 'RELEASE_DAYS_NOT_MET'] },
]
export function gateResults(reasons: string[]): Array<{ key: string; label: string; state: 'PASS' | 'FAIL' }> {
  return SELLABILITY_GATES.map((gate) => ({ key: gate.key, label: gate.label, state: gate.reasons.some((reason) => reasons.includes(reason)) ? 'FAIL' as const : 'PASS' as const }))
}

// ---- hotel assessment ----------------------------------------------------------------------------------------------------
export function assessHotel(input: AssessHotelInput): HotelAssessment {
  const { hotel } = input
  const activePlans = input.plans.filter((plan) => plan.status === 'ACTIVE')
  const assessed = activePlans.map((plan) => assessPlan(plan, input))
  const days = input.dates.length

  // rooms
  const mappingIds = new Set(input.mappings.map((m) => m.id))
  const rooms: RoomAssessment[] = input.rooms.map((room) => {
    const rows = input.roomMappings.filter((row) => row.roomTypeId === room.id && mappingIds.has(row.supplierHotelMappingId))
    const plans = assessed.filter((assessment) => assessment.plan.roomTypeId === room.id)
    const reasonCounts = new Map<string, number>()
    let sellable = 0; let total = 0
    for (const assessment of plans) for (const night of assessment.nights) { total += 1; if (night.sellable) sellable += 1; for (const reason of night.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1) }
    if (plans.length === 0) reasonCounts.set(input.plans.some((p) => p.roomTypeId === room.id) ? 'RATE_PLAN_INACTIVE' : 'RATE_PLAN_MISSING', 1)
    return {
      room, mapping: mappingStateOf(rows.map((row) => row.status)), supplierRoomIds: rows.filter((row) => row.status === 'MAPPED').map((row) => row.supplierRoomId),
      plans, activePlans: plans.length, inventory: inventoryStateOf(plans), readiness: readinessOf(sellable, total), blockers: topReasons(reasonCounts),
    }
  })

  // totals
  const reasonCounts = new Map<string, number>()
  let sellableNights = 0; let totalNights = 0
  for (const assessment of assessed) for (const night of assessment.nights) { totalNights += 1; if (night.sellable) sellableNights += 1; for (const reason of night.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1) }
  if (activePlans.length === 0) reasonCounts.set(input.plans.length > 0 ? 'RATE_PLAN_INACTIVE' : 'RATE_PLAN_MISSING', 1)
  if (activePlans.length === 0 && hotel.contentStatus !== 'COMPLETE') reasonCounts.set('HOTEL_INACTIVE', (reasonCounts.get('HOTEL_INACTIVE') ?? 0) + 1)
  if (activePlans.length === 0 && !starRatingValid(hotel.starRating)) reasonCounts.set(HOTEL_STAR_RATING_MISSING, (reasonCounts.get(HOTEL_STAR_RATING_MISSING) ?? 0) + 1)
  const readiness = readinessOf(sellableNights, totalNights)

  // contracts: those reached through a mapping to this hotel and those reached through its rate plans
  const contractRows = new Map<string, AssessContract>()
  for (const contract of input.contracts) contractRows.set(contract.id, contract)
  for (const plan of input.plans) if (!contractRows.has(plan.contract.id)) contractRows.set(plan.contract.id, { id: plan.contract.id, code: plan.contract.code, status: plan.contract.status, validFrom: plan.contract.validFrom, validTo: plan.contract.validTo, supplierId: plan.contract.supplierId, supplierName: plan.contract.supplier.displayName, supplierStatus: plan.contract.supplier.status, supplierHotelMappingId: plan.contract.supplierHotelMappingId })
  const contractStates = [...contractRows.values()].map((contract) => ({ contract, ...contractStateOf(contract, input.today) }))
  const bestContract = contractStates.sort((a, b) => CONTRACT_RANK[a.state] - CONTRACT_RANK[b.state] || a.daysToExpiry - b.daysToExpiry)[0]
  const contractState: ContractState = bestContract?.state ?? 'NONE'
  const inForce = contractStates.filter((c) => c.state === 'ACTIVE' || c.state === 'EXPIRING')
  const contractDaysToExpiry = inForce.length ? Math.min(...inForce.map((c) => c.daysToExpiry)) : null

  const hotelMapping = mappingStateOf(input.mappings.map((m) => m.status))
  const suppliers = [...new Map([...contractRows.values()].map((c) => [c.supplierId, { id: c.supplierId, displayName: c.supplierName }])).values(), ...input.mappings.map((m) => ({ id: m.supplierId, displayName: m.supplierName }))]
  const uniqueSuppliers = [...new Map(suppliers.map((s) => [s.id, s])).values()].sort((a, b) => a.displayName.localeCompare(b.displayName))

  const sum = (key: keyof PlanAssessment['counts']) => assessed.reduce((total, p) => total + p.counts[key], 0)
  const rates: SupplyDataState = assessed.length === 0 ? 'NONE' : sum('rateMissing') > 0 ? 'GAPS' : 'OK'
  const inventory = inventoryStateOf(assessed)

  const activeRooms = input.rooms.filter((room) => room.isActive)
  const roomCounts = { total: input.rooms.length, active: activeRooms.length, mapped: rooms.filter((room) => room.room.isActive && room.mapping === 'MAPPED').length }

  // gates ---------------------------------------------------------------------------------------------------------------
  const gate = (key: string, label: string, state: GateState, detail: string, section: HotelSection): ReadinessGate => ({ key, label, state, detail, section })
  const missingRate = sum('rateMissing'); const missingAvail = sum('availabilityMissing'); const stopSell = sum('stopSell'); const exhausted = sum('exhausted')
  const frac = (n: number): GateState => (totalNights === 0 ? 'NA' : n === 0 ? 'PASS' : n >= totalNights ? 'FAIL' : 'WARN')
  const masterIssues = [hotel.contentStatus !== 'COMPLETE' ? `content ${hotel.contentStatus}` : null, !starRatingValid(hotel.starRating) ? 'no 1-5 star rating' : null].filter(Boolean)
  const activeSupplier = uniqueSuppliers.length > 0 && [...contractRows.values()].some((c) => c.supplierStatus === 'ACTIVE')
  const gates: ReadinessGate[] = [
    gate('hotel', 'Hotel master', masterIssues.length === 0 ? 'PASS' : 'FAIL', masterIssues.length === 0 ? 'COMPLETE with a star rating' : masterIssues.join(', '), 'overview'),
    gate('supplier', 'Supplier', uniqueSuppliers.length === 0 ? 'FAIL' : activeSupplier ? 'PASS' : 'FAIL', uniqueSuppliers.length === 0 ? 'No supplier is linked by a contract or mapping' : activeSupplier ? uniqueSuppliers.map((s) => s.displayName).join(', ') : 'No linked supplier is ACTIVE', 'contracts'),
    gate('hotelMapping', 'Hotel mapping', hotelMapping === 'MAPPED' ? 'PASS' : hotelMapping === 'PENDING' ? 'WARN' : 'FAIL', hotelMapping === 'NONE' ? 'No supplier hotel mapping' : `Mapping ${hotelMapping}`, 'mappings'),
    gate('rooms', 'Rooms', roomCounts.active > 0 ? 'PASS' : 'FAIL', `${roomCounts.active} active of ${roomCounts.total}`, 'rooms'),
    gate('roomMapping', 'Room mapping', roomCounts.active === 0 ? 'NA' : roomCounts.mapped === roomCounts.active ? 'PASS' : roomCounts.mapped === 0 ? 'FAIL' : 'WARN', `${roomCounts.mapped} / ${roomCounts.active} active rooms mapped`, 'mappings'),
    gate('contract', 'Contract', contractState === 'ACTIVE' ? 'PASS' : contractState === 'EXPIRING' ? 'WARN' : 'FAIL', contractState === 'NONE' ? 'No contract' : contractState === 'EXPIRING' ? `ACTIVE, expires in ${contractDaysToExpiry} days` : contractState, 'contracts'),
    gate('ratePlans', 'Rate plans', activePlans.length > 0 ? 'PASS' : 'FAIL', `${activePlans.length} active of ${input.plans.length}`, 'contracts'),
    gate('dailyRates', 'Daily rates', totalNights === 0 ? 'NA' : frac(missingRate), totalNights === 0 ? 'No active rate plan' : `${missingRate} of ${totalNights} plan-nights missing`, 'rates'),
    gate('availability', 'Availability', totalNights === 0 ? 'NA' : frac(missingAvail), totalNights === 0 ? 'No active rate plan' : `${missingAvail} of ${totalNights} plan-nights missing`, 'rates'),
    gate('stopSell', 'Stop sell', totalNights === 0 ? 'NA' : stopSell === 0 ? 'PASS' : stopSell >= totalNights ? 'FAIL' : 'WARN', stopSell === 0 ? 'None' : `${stopSell} plan-nights on stop-sell`, 'rates'),
    gate('inventory', 'Inventory', totalNights === 0 ? 'NA' : frac(exhausted), exhausted === 0 ? 'Remaining on every assessed night' : `${exhausted} plan-nights exhausted`, 'rates'),
    gate('sellability', 'Final sellability', readiness === 'READY' ? 'PASS' : readiness === 'PARTIAL' ? 'WARN' : 'FAIL', `${sellableNights} of ${totalNights} plan-nights sellable over ${days} nights`, 'sellability'),
  ]

  // issues --------------------------------------------------------------------------------------------------------------
  const issues: CommercialIssue[] = []
  const baseIssue = (over: Partial<CommercialIssue> & Pick<CommercialIssue, 'category' | 'message' | 'id'>): CommercialIssue => ({
    severity: 'WARNING', reason: null, hotelId: hotel.id, hotelName: hotel.name, roomTypeId: null, roomName: null, ratePlanId: null, ratePlanCode: null, supplierId: null, supplierName: null,
    from: null, to: null, nights: 0, section: SECTION_OF_CATEGORY[over.category], observedAt: input.observedAt, ...over,
  })
  const blocked = readiness === 'BLOCKED'
  const severityFor = (category: CommercialIssueCategory, nights: number): IssueSeverity => {
    if (blocked) return 'CRITICAL'
    if (nights >= days || category === 'UNMAPPED_HOTEL' || category === 'UNMAPPED_ROOM' || category === 'ENTITY_INACTIVE') return 'HIGH'
    return 'WARNING'
  }
  // hotel-level (once per hotel, not per plan)
  if (hotel.contentStatus !== 'COMPLETE') issues.push(baseIssue({ id: `${hotel.id}|hotel|HOTEL_INACTIVE`, category: 'HOTEL_CONTENT', reason: 'HOTEL_INACTIVE', severity: blocked ? 'CRITICAL' : 'HIGH', message: `${REASON_TEXT.HOTEL_INACTIVE} (${hotel.contentStatus})`, nights: days }))
  if (!starRatingValid(hotel.starRating)) issues.push(baseIssue({ id: `${hotel.id}|hotel|${HOTEL_STAR_RATING_MISSING}`, category: 'HOTEL_CONTENT', reason: HOTEL_STAR_RATING_MISSING, severity: blocked ? 'CRITICAL' : 'HIGH', message: REASON_TEXT[HOTEL_STAR_RATING_MISSING], nights: days }))
  if (activePlans.length === 0) {
    const reason = input.plans.length > 0 ? 'RATE_PLAN_INACTIVE' : 'RATE_PLAN_MISSING'
    issues.push(baseIssue({ id: `${hotel.id}|hotel|${reason}`, category: 'ENTITY_INACTIVE', reason, severity: 'CRITICAL', section: 'contracts', message: REASON_TEXT[reason] }))
    if (hotelMapping !== 'MAPPED') issues.push(baseIssue({ id: `${hotel.id}|hotel|UNMAPPED_HOTEL`, category: 'UNMAPPED_HOTEL', reason: 'SUPPLIER_MAPPING_INVALID', severity: 'CRITICAL', message: hotelMapping === 'NONE' ? 'No supplier hotel mapping exists' : `Hotel mapping is ${hotelMapping}` }))
  }
  // plan-level: one issue per (plan, reason) with the affected range
  for (const assessment of assessed) {
    const byReason = new Map<string, string[]>()
    for (const night of assessment.nights) for (const reason of night.reasons) { if (HOTEL_LEVEL_REASONS.has(reason)) continue; byReason.set(reason, [...(byReason.get(reason) ?? []), night.date]) }
    for (const [reason, dates] of byReason) {
      const sample = assessment.nights.find((n) => n.reasons.includes(reason))!
      const category = categoryOfReason(reason, { hotelMappingOk: assessment.hotelMappingOk, contractStatus: assessment.plan.contract.status, hasRate: sample.hasRate })
      issues.push(baseIssue({
        id: `${hotel.id}|${assessment.plan.roomTypeId}|${assessment.plan.id}|${reason}`, category, reason, severity: severityFor(category, dates.length),
        roomTypeId: assessment.plan.roomTypeId, roomName: assessment.plan.roomType.name, ratePlanId: assessment.plan.id, ratePlanCode: assessment.plan.code,
        supplierId: assessment.plan.contract.supplierId, supplierName: assessment.plan.contract.supplier.displayName,
        from: dates[0], to: dates[dates.length - 1], nights: dates.length, message: `${assessment.plan.roomType.name} · ${assessment.plan.code}: ${REASON_TEXT[reason] ?? reason}`,
      }))
    }
  }
  // contract expiry warnings (future risk, not a current block)
  for (const row of contractStates) {
    if (row.state !== 'EXPIRING') continue
    issues.push(baseIssue({ id: `${hotel.id}|contract|${row.contract.id}|EXPIRING`, category: 'CONTRACT_EXPIRING', severity: 'WARNING', supplierId: row.contract.supplierId, supplierName: row.contract.supplierName, message: `Contract ${row.contract.code} expires in ${row.daysToExpiry} day${row.daysToExpiry === 1 ? '' : 's'}`, section: 'contracts' }))
  }
  const rank: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 1, WARNING: 2 }
  issues.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.roomName ?? '').localeCompare(b.roomName ?? '') || a.id.localeCompare(b.id))

  return {
    readiness, agentSellable: sellableNights > 0, blockers: topReasons(reasonCounts), contractState, contractDaysToExpiry, hotelMapping, suppliers: uniqueSuppliers,
    rooms, plans: assessed, rates, inventory, gates, issues, roomCounts, planCounts: { total: input.plans.length, active: activePlans.length },
  }
}
