import { cosineSimilarity, HashedTokenEmbeddingProvider, hotelEmbeddingText, type MappingEmbeddingProvider } from './embedding'
import { normalizeHotelIdentity, normalizeRoomIdentity, tokenSimilarity, trigramSimilarity } from './normalize'

export type MappingTier = 'EXACT' | 'HIGH_CONFIDENCE' | 'REVIEW_REQUIRED' | 'NO_MATCH'

export interface HotelMatchCandidate {
  canonicalHotelId: string
  confidenceScore: number
  nameSimilarity: number
  addressSimilarity: number
  vectorSimilarity: number
  geoDistanceMeters: number | null
  matchingReasons: string[]
  tier: MappingTier
}

export interface HotelMatchDecision {
  tier: MappingTier
  autoMap: boolean
  candidates: HotelMatchCandidate[]
}

export interface SupplierHotelObservation {
  supplierHotelId: string
  name: string
  address?: string | null
  city?: string | null
  countryCode?: string | null
  postalCode?: string | null
  latitude?: number | null
  longitude?: number | null
  brand?: string | null
  knownCanonicalHotelId?: string | null
}

export interface CanonicalHotelObservation {
  hotelId: string
  name: string
  address?: string | null
  city: string
  countryCode: string
  latitude?: number | null
  longitude?: number | null
  brand?: string | null
}

const AUTO_SCORE = 92
const REVIEW_SCORE = 70
const NAME_AUTO = 0.88
const ADDRESS_SUPPORT = 0.75
const GEO_SUPPORT_METERS = 500
const CANDIDATE_GAP = 8

const embeddings = new HashedTokenEmbeddingProvider()

export function matchSupplierHotel(supplier: SupplierHotelObservation, catalog: CanonicalHotelObservation[], embedder: MappingEmbeddingProvider = embeddings): HotelMatchDecision {
  const known = supplier.knownCanonicalHotelId
    ? catalog.find((hotel) => hotel.hotelId === supplier.knownCanonicalHotelId)
    : undefined
  if (known) {
    return { tier: 'EXACT', autoMap: true, candidates: [candidate(known.hotelId, 100, 1, 1, 1, null, ['approved_supplier_mapping'], 'EXACT')] }
  }

  const incoming = normalizeHotelIdentity(supplier)
  const incomingVector = embedder.embed(hotelEmbeddingText(incoming))
  const scored = catalog.map((hotel) => scoreHotel(supplier, incoming, incomingVector, hotel, embedder))
    .sort((left, right) => right.confidenceScore - left.confidenceScore)

  const best = scored[0]
  const second = scored[1]
  if (!best || best.tier === 'NO_MATCH') return { tier: 'NO_MATCH', autoMap: false, candidates: scored.slice(0, 5) }
  const gap = second ? best.confidenceScore - second.confidenceScore : CANDIDATE_GAP
  const ambiguous = second !== undefined && gap < CANDIDATE_GAP && second.tier !== 'NO_MATCH'
  if (ambiguous && best.tier !== 'EXACT') {
    const reviewed = scored.slice(0, 5).map((item) => item.tier === 'NO_MATCH' ? item : { ...item, tier: 'REVIEW_REQUIRED' as const, matchingReasons: [...item.matchingReasons, 'ambiguous_candidate'] })
    return { tier: 'REVIEW_REQUIRED', autoMap: false, candidates: reviewed }
  }
  const autoMap = best.tier === 'EXACT' || (best.tier === 'HIGH_CONFIDENCE' && gap >= CANDIDATE_GAP)
  return { tier: best.tier, autoMap, candidates: scored.slice(0, 5) }
}

function scoreHotel(supplier: SupplierHotelObservation, incoming: ReturnType<typeof normalizeHotelIdentity>, incomingVector: number[], hotel: CanonicalHotelObservation, embedder: MappingEmbeddingProvider): HotelMatchCandidate {
  const canonical = normalizeHotelIdentity(hotel)
  const reasons: string[] = []
  if (incoming.normalizedCountryCode && canonical.normalizedCountryCode && incoming.normalizedCountryCode !== canonical.normalizedCountryCode) {
    return candidate(hotel.hotelId, 0, 0, 0, 0, null, ['country_mismatch'], 'NO_MATCH')
  }
  const nameSimilarity = Math.max(trigramSimilarity(incoming.normalizedName, canonical.normalizedName), tokenSimilarity(incoming.normalizedName, canonical.normalizedName))
  const addressSimilarity = incoming.normalizedAddress && canonical.normalizedAddress
    ? trigramSimilarity(incoming.normalizedAddress, canonical.normalizedAddress)
    : 0
  const vector = embedder.embed(hotelEmbeddingText(canonical))
  const vectorSimilarity = Math.max(0, cosineSimilarity(incomingVector, vector))
  const geo = geoDistance(supplier, hotel)
  const cityCompatible = !incoming.normalizedCity || !canonical.normalizedCity || incoming.normalizedCity === canonical.normalizedCity
  if (!cityCompatible) reasons.push('city_mismatch')
  if (nameSimilarity >= NAME_AUTO) reasons.push('name_similarity')
  if (addressSimilarity >= ADDRESS_SUPPORT) reasons.push('address_similarity')
  if (vectorSimilarity >= 0.8) reasons.push('vector_similarity')
  if (geo !== null && geo <= GEO_SUPPORT_METERS) reasons.push('geo_proximity')
  if (geo !== null && geo > 5_000) reasons.push('geo_conflict')

  let score = Math.round(nameSimilarity * 45 + (incoming.normalizedAddress && canonical.normalizedAddress ? addressSimilarity * 25 : 12) + vectorSimilarity * 15)
  if (addressSimilarity === 1) score += 12
  if (geo !== null && geo <= GEO_SUPPORT_METERS) score += 15
  else if (geo !== null && geo <= 1_000) score += 8
  else if (geo !== null && geo > 5_000) score -= 25
  if (!cityCompatible) score -= 40
  score = Math.max(0, Math.min(100, score))

  const exactIdentity = nameSimilarity === 1 && cityCompatible && (!incoming.normalizedCountryCode || incoming.normalizedCountryCode === canonical.normalizedCountryCode)
    && (addressSimilarity >= 0.95 || (!incoming.normalizedAddress && !canonical.normalizedAddress))
    && (geo === null || geo <= 1_000)
  const supporting = addressSimilarity >= ADDRESS_SUPPORT || (geo !== null && geo <= GEO_SUPPORT_METERS)
  let tier: MappingTier = 'NO_MATCH'
  if (exactIdentity && (geo === null || geo <= 1_000)) tier = 'EXACT'
  else if (score >= AUTO_SCORE && nameSimilarity >= 0.75 && cityCompatible && supporting && (geo === null || geo <= 5_000)) tier = 'HIGH_CONFIDENCE'
  else if (score >= REVIEW_SCORE && cityCompatible) tier = 'REVIEW_REQUIRED'
  if (tier === 'EXACT') reasons.unshift('normalized_identity')
  return candidate(hotel.hotelId, score, round3(nameSimilarity), round3(addressSimilarity), round3(vectorSimilarity), geo === null ? null : Math.round(geo), reasons, tier)
}

function candidate(id: string, score: number, name: number, address: number, vector: number, geo: number | null, reasons: string[], tier: MappingTier): HotelMatchCandidate {
  return { canonicalHotelId: id, confidenceScore: score, nameSimilarity: name, addressSimilarity: address, vectorSimilarity: vector, geoDistanceMeters: geo, matchingReasons: reasons, tier }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function geoDistance(incoming: { latitude?: number | null; longitude?: number | null }, hotel: CanonicalHotelObservation): number | null {
  if (incoming.latitude == null || incoming.longitude == null || hotel.latitude == null || hotel.longitude == null) return null
  const toRad = (value: number) => value * Math.PI / 180
  const dLat = toRad(hotel.latitude - incoming.latitude)
  const dLon = toRad(hotel.longitude - incoming.longitude)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(incoming.latitude)) * Math.cos(toRad(hotel.latitude)) * Math.sin(dLon / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export interface RoomMatchCandidate {
  canonicalRoomTypeId: string
  confidence: number
  reasons: string[]
  tier: MappingTier
}

export interface SupplierRoomObservation {
  name: string
  hotelId: string
  occupancy?: number | null
  bedType?: string | null
  view?: string | null
}

export interface CanonicalRoomObservation {
  roomTypeId: string
  hotelId: string
  name: string
  maxOccupancy: number
}

export function matchSupplierRoom(supplier: SupplierRoomObservation, rooms: CanonicalRoomObservation[]): { tier: MappingTier; autoMap: boolean; candidates: RoomMatchCandidate[] } {
  const scoped = rooms.filter((room) => room.hotelId === supplier.hotelId)
  const incoming = normalizeRoomIdentity(supplier)
  const scored = scoped.map((room) => scoreRoom(incoming, supplier, room))
    .sort((left, right) => right.confidence - left.confidence)
  const best = scored[0]
  const second = scored[1]
  if (!best || best.tier === 'NO_MATCH') return { tier: 'NO_MATCH', autoMap: false, candidates: scored.slice(0, 5) }
  const ambiguous = second !== undefined && best.confidence - second.confidence < CANDIDATE_GAP && second.tier !== 'NO_MATCH'
  if (ambiguous && best.tier !== 'EXACT') {
    return { tier: 'REVIEW_REQUIRED', autoMap: false, candidates: scored.slice(0, 5).map((item) => ({ ...item, tier: item.tier === 'NO_MATCH' ? item.tier : 'REVIEW_REQUIRED' as const, reasons: [...item.reasons, 'ambiguous_candidate'] })) }
  }
  return { tier: best.tier, autoMap: best.tier === 'EXACT' || best.tier === 'HIGH_CONFIDENCE', candidates: scored.slice(0, 5) }
}

function scoreRoom(incoming: ReturnType<typeof normalizeRoomIdentity>, supplier: SupplierRoomObservation, room: CanonicalRoomObservation): RoomMatchCandidate {
  const canonical = normalizeRoomIdentity({ name: room.name })
  const reasons: string[] = []
  if (supplier.occupancy != null && supplier.occupancy > room.maxOccupancy) {
    return { canonicalRoomTypeId: room.roomTypeId, confidence: 0, reasons: ['occupancy_mismatch'], tier: 'NO_MATCH' }
  }
  if (incoming.bedType && canonical.bedType && incoming.bedType !== canonical.bedType) {
    return { canonicalRoomTypeId: room.roomTypeId, confidence: 20, reasons: ['bed_type_mismatch'], tier: 'NO_MATCH' }
  }
  if (incoming.view && canonical.view && incoming.view !== canonical.view) {
    return { canonicalRoomTypeId: room.roomTypeId, confidence: 35, reasons: ['view_mismatch'], tier: 'REVIEW_REQUIRED' }
  }
  const nameSimilarity = Math.max(trigramSimilarity(incoming.normalizedName, canonical.normalizedName), tokenSimilarity(incoming.normalizedName, canonical.normalizedName))
  if (incoming.bedType && incoming.bedType === canonical.bedType) reasons.push('bed_type')
  if (incoming.view && incoming.view === canonical.view) reasons.push('view')
  if (nameSimilarity >= 0.9) reasons.push('room_name_similarity')
  const score = Math.round(nameSimilarity * 80 + (incoming.bedType && incoming.bedType === canonical.bedType ? 10 : 0) + (incoming.view && incoming.view === canonical.view ? 10 : 0))
  const tier: MappingTier = nameSimilarity === 1 && (!incoming.view || incoming.view === canonical.view) && (!incoming.bedType || incoming.bedType === canonical.bedType)
    ? 'EXACT'
    : score >= 88 && nameSimilarity >= 0.85 ? 'HIGH_CONFIDENCE'
      : score >= 70 ? 'REVIEW_REQUIRED' : 'NO_MATCH'
  return { canonicalRoomTypeId: room.roomTypeId, confidence: Math.min(100, score), reasons, tier }
}

export function summarizeMappingDecisions(decisions: Array<{ tier: MappingTier; autoMap: boolean }>) {
  const summary = { incoming: decisions.length, exact: 0, autoMapped: 0, reviewRequired: 0, unmatched: 0, averageConfidence: 0 }
  for (const decision of decisions) {
    if (decision.tier === 'EXACT') summary.exact += 1
    if (decision.autoMap) summary.autoMapped += 1
    if (decision.tier === 'REVIEW_REQUIRED') summary.reviewRequired += 1
    if (decision.tier === 'NO_MATCH') summary.unmatched += 1
  }
  return summary
}
