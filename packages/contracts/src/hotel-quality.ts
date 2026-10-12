/**
 * Hotel content quality and catalogue integrity (ADR 0057).
 *
 * Advisory only: nothing here changes publishability, sellability, rates or inventory. `HOTEL_PUBLICATION_REQUIREMENTS`
 * remains the only publication gate. The score exists so operators can prioritise content work the way global bedbanks
 * grade their static content, and so a near-duplicate property is noticed before it is published or mapped twice.
 */
export const HOTEL_QUALITY_SIGNALS = [
  { key: 'FULL_DESCRIPTION', label: 'Full description (200+ characters)', weight: 15, tab: 'setup' },
  { key: 'SHORT_DESCRIPTION_LENGTH', label: 'Short description of at least 40 characters', weight: 5, tab: 'setup' },
  { key: 'PRIMARY_IMAGE', label: 'Primary image with alt text', weight: 20, tab: 'images' },
  { key: 'GALLERY', label: 'At least 5 images', weight: 10, tab: 'images' },
  { key: 'AMENITIES', label: 'At least 5 amenities from the catalogue', weight: 10, tab: 'amenities' },
  { key: 'LANGUAGES', label: 'Content languages recorded', weight: 5, tab: 'setup' },
  { key: 'POLICIES', label: 'At least 3 hotel policies', weight: 10, tab: 'policies' },
  { key: 'STAR_SOURCE', label: 'Star category source recorded', weight: 5, tab: 'setup' },
  { key: 'EXTERNAL_ID', label: 'External identifier such as GIATA', weight: 10, tab: 'setup' },
  { key: 'POSTAL_AREA', label: 'Postal code and area', weight: 5, tab: 'setup' },
  { key: 'CHAIN_BRAND', label: 'Chain or brand recorded', weight: 5, tab: 'setup' },
] as const satisfies ReadonlyArray<{ key: string; label: string; weight: number; tab: 'setup' | 'images' | 'amenities' | 'policies' }>
export type HotelQualitySignalKey = (typeof HOTEL_QUALITY_SIGNALS)[number]['key']

export const HOTEL_QUALITY_TIERS = ['BRONZE', 'SILVER', 'GOLD'] as const
export type HotelQualityTier = (typeof HOTEL_QUALITY_TIERS)[number]

export interface HotelQualitySignalResult { key: HotelQualitySignalKey; label: string; weight: number; met: boolean; tab: 'setup' | 'images' | 'amenities' | 'policies' }
export interface HotelContentQuality {
  /** 0-100, the sum of met signal weights. */
  score: number
  /** BRONZE below 50, SILVER 50-79, GOLD 80 and above. */
  tier: HotelQualityTier
  signals: HotelQualitySignalResult[]
}

export type HotelDuplicateBasis = 'SAME_EXTERNAL_ID' | 'NEAR_LOCATION_SIMILAR_NAME' | 'SAME_POSTAL_SIMILAR_NAME'
/** A possible duplicate inside the same tenant. A hint for a human, never an automatic merge or block. */
export interface HotelDuplicateCandidate { hotelId: string; name: string; city: string; countryCode: string; status: string; basis: HotelDuplicateBasis[]; distanceMetres: number | null }

/**
 * Approving a hotel mapping is refused (409) when the same supplier is already MAPPED to a likely-duplicate canonical hotel, because the
 * supplier's inventory would then be sold under two identities (ADR 0059). The approver may proceed by naming each such hotel in
 * `acknowledgeDuplicateHotelIds` together with a reason; the acknowledgement is audited.
 */
export const MAPPING_DUPLICATE_CONFLICT_CODE = 'MAPPING_LIKELY_DUPLICATE_CANONICAL'
export interface HotelMappingApproveBody { reason?: string; acknowledgeDuplicateHotelIds?: string[] }
