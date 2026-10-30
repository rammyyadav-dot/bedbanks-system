import { ONBOARDING_STAGE_IDS, type OnboardingBlockedHotel, type OnboardingFunnelReport, type OnboardingStageId } from '@bedbanks/contracts'

/** Per-hotel structural facts, one flag per stage after CREATED. `null` means the caller may not read that evidence. */
export type HotelStageFacts = Partial<Record<Exclude<OnboardingStageId, 'CREATED'>, boolean | null>>
export interface FunnelHotel { hotelId: string; hotelName: string; city: string; facts: HotelStageFacts }

const STAGE_META: Record<OnboardingStageId, { label: string; permission: string | null }> = {
  CREATED: { label: 'Hotel created', permission: null },
  PUBLISHED: { label: 'Hotel profile published', permission: null },
  ROOMS_DEFINED: { label: 'Active room type defined', permission: 'supply.rooms.read' },
  HOTEL_MAPPED: { label: 'Supplier hotel mapping approved', permission: 'supply.mappings.read' },
  ROOMS_MAPPED: { label: 'Supplier room mapping approved', permission: 'supply.mappings.read' },
  CONTRACT_ACTIVE: { label: 'Active, unexpired contract', permission: 'supply.contracts.read' },
  RATE_PLAN_ACTIVE: { label: 'Active rate plan on an active contract', permission: 'supply.rates.read' },
  RATES_LOADED: { label: 'Future SELL/NET-classified daily rates', permission: 'supply.rates.read' },
  INVENTORY_LOADED: { label: 'Future open stock', permission: 'supply.availability.read' },
}

export const BLOCKED_HOTELS_LIMIT = 200

export const ONBOARDING_SCOPE = 'Structural catalogue progress per hotel from the masters, as of the evaluation date.'
export const ONBOARDING_LIMITATIONS = [
  'A hotel at the last stage is a candidate, not a certified sellable hotel: stay restrictions, occupancy, buyer eligibility and currency are judged per search by the readiness assessment.',
  'Stock counts a plan with an open future night, or a pooled plan whose pool has an open future night; it does not prove the open nights cover any particular stay.',
  'Counts are tenant-wide and cover hotels in every content status, including archived and suspended hotels.',
  'The report does not contact suppliers and says nothing about supplier-side onboarding or live search and recheck behaviour.',
]

/** Pure: cumulative funnel over per-hotel facts. A null (unreadable) stage and everything after it is reported as null. */
export function buildOnboardingFunnel(hotels: FunnelHotel[], held: ReadonlySet<string>, evaluatedAt: Date, asOfDate: string): OnboardingFunnelReport {
  const stages = ONBOARDING_STAGE_IDS.slice(1) as Array<Exclude<OnboardingStageId, 'CREATED'>>
  // The first stage the caller cannot read; it and every later stage is UNKNOWN.
  const unreadableFrom = stages.findIndex(stage => { const p = STAGE_META[stage].permission; return p !== null && !held.has(p) })
  const readable = unreadableFrom === -1 ? stages : stages.slice(0, unreadableFrom)

  const reached: Record<string, number> = { CREATED: hotels.length }
  const blockerCounts: Record<string, number> = {}
  const blockedHotels: OnboardingBlockedHotel[] = []
  let complete = 0
  for (const hotel of hotels) {
    let last: OnboardingStageId = 'CREATED'
    let blocker: OnboardingStageId | null = null
    for (const stage of readable) {
      if (hotel.facts[stage] === true) { reached[stage] = (reached[stage] ?? 0) + 1; last = stage } else { blocker = stage; break }
    }
    if (blocker) {
      blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1
      blockedHotels.push({ hotelId: hotel.hotelId, hotelName: hotel.hotelName, city: hotel.city, lastStageReached: last, blocker })
    } else if (unreadableFrom === -1) complete += 1
  }
  blockedHotels.sort((a, b) => a.hotelName.localeCompare(b.hotelName) || a.hotelId.localeCompare(b.hotelId))
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    asOfDate,
    totalHotels: hotels.length,
    completeHotels: unreadableFrom === -1 ? complete : null,
    stages: ONBOARDING_STAGE_IDS.map(stage => ({ stage, ...STAGE_META[stage], reached: stage === 'CREATED' ? hotels.length : readable.includes(stage as never) ? reached[stage] ?? 0 : null })),
    blockers: stages.map(stage => ({ stage, hotels: readable.includes(stage) ? blockerCounts[stage] ?? 0 : null })),
    blockedHotels: blockedHotels.slice(0, BLOCKED_HOTELS_LIMIT),
    blockedHotelsLimit: BLOCKED_HOTELS_LIMIT,
    blockedHotelsTruncated: blockedHotels.length > BLOCKED_HOTELS_LIMIT,
    scope: ONBOARDING_SCOPE,
    limitations: ONBOARDING_LIMITATIONS,
  }
}
