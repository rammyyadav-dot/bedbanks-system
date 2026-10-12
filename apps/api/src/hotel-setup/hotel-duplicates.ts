import type { HotelDuplicateBasis, HotelDuplicateCandidate } from '@bedbanks/contracts'

/**
 * Near-duplicate detection inside one tenant (ADR 0057). Pure. Exact name+city+address collisions are already refused by
 * `assertHotelIdentityAvailable`; this finds the cases global bedbanks de-duplicate by hand: the same property entered with a
 * different spelling, or by two suppliers. (A shared external identifier is not a signal: the database already makes identifiers unique per tenant.) It only ever produces a hint and never blocks, merges or deletes.
 */
export interface DuplicateSubject { id: string; name: string; city: string; countryCode: string; postalCode: string | null; latitude: number | null; longitude: number | null; status: string }

const NOISE = new Set(['hotel', 'hotels', 'resort', 'resorts', 'the', 'and', 'by', 'spa', 'suites', 'suite', 'apartments', 'apartment', 'residence', 'residences', 'inn', 'at', 'of', 'a'])

/** Lower-case ASCII tokens without accents, punctuation and generic property words, so "The Palm View Hotel & Spa" matches "Palm View". */
export function nameTokens(name: string): string[] {
  const t = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const meaningful = t.filter((x) => !NOISE.has(x))
  return meaningful.length ? meaningful : t
}

/** Jaccard similarity of the two token sets, 0 to 1. */
export function nameSimilarity(a: string, b: string): number {
  const x = new Set(nameTokens(a)), y = new Set(nameTokens(b))
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const t of x) if (y.has(t)) shared += 1
  return shared / (x.size + y.size - shared)
}

/** Great-circle distance in metres (haversine). Coordinates are display values, so floats are fine; no money is involved. */
export function distanceMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = 6371000, rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const DUPLICATE_RADIUS_METRES = 150
export const DUPLICATE_NAME_THRESHOLD = 0.6

export function findPossibleDuplicates(subject: DuplicateSubject, candidates: DuplicateSubject[], limit = 5): HotelDuplicateCandidate[] {
  const out: Array<HotelDuplicateCandidate & { rank: number }> = []
  for (const c of candidates) {
    if (c.id === subject.id || c.countryCode !== subject.countryCode) continue
    const basis: HotelDuplicateBasis[] = []
    const similar = nameSimilarity(subject.name, c.name) >= DUPLICATE_NAME_THRESHOLD
    let distance: number | null = null
    if (subject.latitude !== null && subject.longitude !== null && c.latitude !== null && c.longitude !== null) distance = Math.round(distanceMetres(subject.latitude, subject.longitude, c.latitude, c.longitude))
    if (similar && distance !== null && distance <= DUPLICATE_RADIUS_METRES) basis.push('NEAR_LOCATION_SIMILAR_NAME')
    if (similar && subject.postalCode && c.postalCode && subject.postalCode.trim().toLowerCase() === c.postalCode.trim().toLowerCase() && subject.city.trim().toLowerCase() === c.city.trim().toLowerCase()) basis.push('SAME_POSTAL_SIMILAR_NAME')
    if (basis.length) out.push({ hotelId: c.id, name: c.name, city: c.city, countryCode: c.countryCode, status: c.status, basis, distanceMetres: distance, rank: basis.includes('NEAR_LOCATION_SIMILAR_NAME') ? 0 : 1 })
  }
  return out.sort((a, b) => a.rank - b.rank || (a.distanceMetres ?? Infinity) - (b.distanceMetres ?? Infinity) || a.hotelId.localeCompare(b.hotelId)).slice(0, limit).map(({ rank: _rank, ...rest }) => rest)
}
