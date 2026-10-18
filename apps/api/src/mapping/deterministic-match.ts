import { comparePhones, normalizePostalCode, normalizeRegistryCode } from './attributes'
import { normalizeHotelIdentity, tokenSimilarity, trigramSimilarity } from './normalize'
import { geoDistance, type CanonicalHotelObservation, type SupplierHotelObservation } from './hybrid-match'

export interface StrongIdentifiers {
  phone?: string | null
  postalCode?: string | null
  /** Official registry, trade-licence or tax identifier. */
  registryCode?: string | null
}

export type DeterministicRule = 'registry_code' | 'phone' | 'geo_postal'

export type DeterministicMatch =
  | { status: 'MATCH'; canonicalHotelId: string; rule: DeterministicRule; reasons: string[] }
  | { status: 'AMBIGUOUS'; candidateIds: string[]; reasons: string[] }
  | { status: 'CONFLICT'; candidateIds: string[]; reasons: string[] }
  | { status: 'NONE' }

const GEO_POSTAL_METERS = 100
/** A shared identifier on a hotel with an unrelated name is a keying error or a chain switchboard, not proof. */
const NAME_FLOOR = { registry_code: 0.3, phone: 0.5, geo_postal: 0.6 } as const

type Observed<T> = T & StrongIdentifiers

/**
 * Strict-identifier layer. It only proposes a match when exactly one canonical hotel satisfies a rule, the country agrees and the names
 * are not contradictory. Anything else is AMBIGUOUS or CONFLICT and must be reviewed by a person; the probabilistic layer never overrides it.
 */
export function deterministicHotelMatch(supplier: Observed<SupplierHotelObservation>, catalog: Array<Observed<CanonicalHotelObservation>>): DeterministicMatch {
  const incoming = normalizeHotelIdentity(supplier)
  const registry = normalizeRegistryCode(supplier.registryCode)
  const postal = normalizePostalCode(supplier.postalCode)

  const hits = new Map<string, { rule: DeterministicRule; reasons: string[] }>()
  const conflicts = new Map<string, string[]>()

  for (const hotel of catalog) {
    const canonical = normalizeHotelIdentity(hotel)
    if (incoming.normalizedCountryCode && canonical.normalizedCountryCode && incoming.normalizedCountryCode !== canonical.normalizedCountryCode) continue
    const nameSimilarity = Math.max(trigramSimilarity(incoming.normalizedName, canonical.normalizedName), tokenSimilarity(incoming.normalizedName, canonical.normalizedName))

    const sameRegistry = registry !== '' && registry === normalizeRegistryCode(hotel.registryCode)
    if (sameRegistry) {
      if (nameSimilarity >= NAME_FLOOR.registry_code) hits.set(hotel.hotelId, { rule: 'registry_code', reasons: ['registry_code_exact'] })
      else conflicts.set(hotel.hotelId, ['registry_code_exact', 'name_contradiction'])
      continue
    }

    const phone = comparePhones(supplier.phone, hotel.phone)
    if (phone === 'international' && nameSimilarity >= NAME_FLOOR.phone) {
      hits.set(hotel.hotelId, { rule: 'phone', reasons: ['phone_exact'] })
      continue
    }

    const distance = geoDistance(supplier, hotel)
    if (postal !== '' && postal === normalizePostalCode(hotel.postalCode) && distance !== null && distance <= GEO_POSTAL_METERS && nameSimilarity >= NAME_FLOOR.geo_postal) {
      hits.set(hotel.hotelId, { rule: 'geo_postal', reasons: ['postal_code_exact', 'geo_within_100m'] })
    }
  }

  if (conflicts.size > 0) {
    const ids = [...conflicts.keys()]
    return { status: 'CONFLICT', candidateIds: ids, reasons: conflicts.get(ids[0]) ?? [] }
  }
  if (hits.size === 1) {
    const [[canonicalHotelId, hit]] = [...hits.entries()]
    return { status: 'MATCH', canonicalHotelId, rule: hit.rule, reasons: hit.reasons }
  }
  if (hits.size > 1) return { status: 'AMBIGUOUS', candidateIds: [...hits.keys()], reasons: ['multiple_strong_identifier_hits'] }
  return { status: 'NONE' }
}
