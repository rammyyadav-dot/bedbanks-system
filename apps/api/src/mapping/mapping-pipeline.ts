import { normalizeAmenity, normalizeBoardBasis, type AmenityCode, type BoardBasisCode } from './attributes'
import { deterministicHotelMatch, type StrongIdentifiers } from './deterministic-match'
import {
  matchSupplierHotel, matchSupplierRoom,
  type CanonicalHotelObservation, type CanonicalRoomObservation, type HotelMatchCandidate, type MappingTier,
  type RoomMatchCandidate, type SupplierHotelObservation, type SupplierRoomObservation,
} from './hybrid-match'

/**
 * Transport-agnostic mapping pipeline. It classifies supplier records; it does not write. Persistence, audit and the maker-checker
 * approval stay in MappingService (ADR 0004), and only AUTO_MAP results may be persisted without a person.
 */
export type PipelineRoute = 'AUTO_MAP' | 'REVIEW_QUEUE' | 'UNMATCHED'
export type PipelineMethod = 'KNOWN' | 'DETERMINISTIC' | 'PROBABILISTIC' | 'NONE'

export interface HotelMappingDecision {
  supplierHotelId: string
  route: PipelineRoute
  method: PipelineMethod
  canonicalHotelId: string | null
  /** Integer 0..100. */
  confidence: number
  reasons: string[]
  candidates: Array<Pick<HotelMatchCandidate, 'canonicalHotelId' | 'confidenceScore' | 'matchingReasons'>>
}

type SupplierHotelInput = SupplierHotelObservation & StrongIdentifiers
type CanonicalHotelInput = CanonicalHotelObservation & StrongIdentifiers

const DETERMINISTIC_CONFIDENCE = 98

export function mapSupplierHotels(supplierHotels: SupplierHotelInput[], catalog: CanonicalHotelInput[]): HotelMappingDecision[] {
  const decisions = supplierHotels.map((hotel) => decideHotel(hotel, catalog))

  // ADR 0004: one supplier may map a canonical hotel only once. Two supplier records claiming the same canonical hotel
  // are a likely duplicate listing; neither is trusted without a person.
  const claims = new Map<string, HotelMappingDecision[]>()
  for (const decision of decisions) {
    if (decision.route !== 'AUTO_MAP' || !decision.canonicalHotelId) continue
    claims.set(decision.canonicalHotelId, [...(claims.get(decision.canonicalHotelId) ?? []), decision])
  }
  for (const contested of claims.values()) {
    if (contested.length < 2) continue
    for (const decision of contested) {
      decision.route = 'REVIEW_QUEUE'
      decision.reasons = [...decision.reasons, 'supplier_duplicate_in_batch']
    }
  }
  return decisions
}

function decideHotel(hotel: SupplierHotelInput, catalog: CanonicalHotelInput[]): HotelMappingDecision {
  if (hotel.knownCanonicalHotelId && catalog.some((item) => item.hotelId === hotel.knownCanonicalHotelId)) {
    return decision(hotel, 'AUTO_MAP', 'KNOWN', hotel.knownCanonicalHotelId, 100, ['approved_supplier_mapping'], [])
  }

  const strict = deterministicHotelMatch(hotel, catalog)
  if (strict.status === 'MATCH') {
    return decision(hotel, 'AUTO_MAP', 'DETERMINISTIC', strict.canonicalHotelId, DETERMINISTIC_CONFIDENCE, [`deterministic_${strict.rule}`, ...strict.reasons], [])
  }
  if (strict.status === 'AMBIGUOUS' || strict.status === 'CONFLICT') {
    const candidates = strict.candidateIds.map((id) => ({ canonicalHotelId: id, confidenceScore: 0, matchingReasons: strict.reasons }))
    return decision(hotel, 'REVIEW_QUEUE', 'DETERMINISTIC', null, 0, [strict.status === 'CONFLICT' ? 'strong_identifier_conflict' : 'strong_identifier_ambiguous', ...strict.reasons], candidates)
  }

  const fuzzy = matchSupplierHotel(hotel, catalog)
  const best = fuzzy.candidates[0]
  const summary = fuzzy.candidates.map((item) => ({ canonicalHotelId: item.canonicalHotelId, confidenceScore: item.confidenceScore, matchingReasons: item.matchingReasons }))
  if (fuzzy.autoMap && best) return decision(hotel, 'AUTO_MAP', 'PROBABILISTIC', best.canonicalHotelId, best.confidenceScore, best.matchingReasons, summary)
  if (fuzzy.tier === 'REVIEW_REQUIRED') return decision(hotel, 'REVIEW_QUEUE', 'PROBABILISTIC', best?.canonicalHotelId ?? null, best?.confidenceScore ?? 0, best?.matchingReasons ?? [], summary)
  return decision(hotel, 'UNMATCHED', 'NONE', null, best?.confidenceScore ?? 0, ['no_candidate_above_review_threshold'], summary)
}

function decision(hotel: SupplierHotelInput, route: PipelineRoute, method: PipelineMethod, canonicalHotelId: string | null, confidence: number, reasons: string[], candidates: HotelMappingDecision['candidates']): HotelMappingDecision {
  return { supplierHotelId: hotel.supplierHotelId, route, method, canonicalHotelId, confidence: Math.round(confidence), reasons, candidates }
}

export interface RoomMappingDecision {
  supplierRoomId: string
  route: PipelineRoute
  canonicalRoomTypeId: string | null
  confidence: number
  tier: MappingTier
  reasons: string[]
  candidates: RoomMatchCandidate[]
}

/** Rooms are matched only inside the already-mapped canonical hotel. */
export function mapSupplierRooms(rooms: Array<SupplierRoomObservation & { supplierRoomId: string }>, canonical: CanonicalRoomObservation[]): RoomMappingDecision[] {
  return rooms.map((room): RoomMappingDecision => {
    const result = matchSupplierRoom(room, canonical)
    const best = result.candidates[0]
    const route: PipelineRoute = result.autoMap ? 'AUTO_MAP' : result.tier === 'REVIEW_REQUIRED' ? 'REVIEW_QUEUE' : 'UNMATCHED'
    return {
      supplierRoomId: room.supplierRoomId, route, tier: result.tier, candidates: result.candidates,
      canonicalRoomTypeId: route === 'UNMATCHED' ? null : best?.canonicalRoomTypeId ?? null,
      confidence: best?.confidence ?? 0,
      reasons: best?.reasons ?? [],
    }
  })
}

export interface VocabularyDecision<Code extends string> {
  supplierValue: string
  route: 'AUTO_MAP' | 'REVIEW_QUEUE'
  code: Code | null
}

export function mapBoardBases(values: string[]): Array<VocabularyDecision<BoardBasisCode>> {
  return uniqueValues(values).map((supplierValue) => {
    const code = normalizeBoardBasis(supplierValue)
    return { supplierValue, code, route: code ? 'AUTO_MAP' : 'REVIEW_QUEUE' }
  })
}

export function mapAmenities(values: string[]): Array<VocabularyDecision<AmenityCode>> {
  return uniqueValues(values).map((supplierValue) => {
    const code = normalizeAmenity(supplierValue)
    return { supplierValue, code, route: code ? 'AUTO_MAP' : 'REVIEW_QUEUE' }
  })
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export interface PipelineSummary { incoming: number; autoMapped: number; reviewQueue: number; unmatched: number; averageConfidence: number }

export function summarizeRoutes(decisions: Array<{ route: PipelineRoute; confidence: number }>): PipelineSummary {
  const summary: PipelineSummary = { incoming: decisions.length, autoMapped: 0, reviewQueue: 0, unmatched: 0, averageConfidence: 0 }
  let total = 0
  for (const item of decisions) {
    total += item.confidence
    if (item.route === 'AUTO_MAP') summary.autoMapped += 1
    else if (item.route === 'REVIEW_QUEUE') summary.reviewQueue += 1
    else summary.unmatched += 1
  }
  summary.averageConfidence = decisions.length ? Math.round(total / decisions.length) : 0
  return summary
}

/** Review queue ordering: strongest candidates first so reviewers clear the cheap decisions, ties broken by supplier id for stable paging. */
export function reviewQueueOrder<T extends { route: PipelineRoute; confidence: number; supplierHotelId?: string; supplierRoomId?: string }>(decisions: T[]): T[] {
  return decisions
    .filter((item) => item.route === 'REVIEW_QUEUE')
    .sort((a, b) => b.confidence - a.confidence || (a.supplierHotelId ?? a.supplierRoomId ?? '').localeCompare(b.supplierHotelId ?? b.supplierRoomId ?? ''))
}
