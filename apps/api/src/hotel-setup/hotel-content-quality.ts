import { HOTEL_QUALITY_SIGNALS, type HotelContentQuality, type HotelQualitySignalKey, type HotelQualityTier } from '@bedbanks/contracts'

/** Facts the grade is computed from. Counts come from the database; nothing here performs I/O. */
export interface QualityFacts {
  shortDescription: string | null; fullDescription: string | null; languages: string[]
  starSource: string | null; postalCode: string | null; area: string | null; chainName: string | null; brandName: string | null
  policyCount: number; externalIdentifierCount: number; imageCount: number; hasPrimaryImage: boolean; amenityCount: number
}

const len = (v: string | null) => (v ?? '').trim().length
const present = (v: string | null) => len(v) > 0

export function tierFor(score: number): HotelQualityTier { return score >= 80 ? 'GOLD' : score >= 50 ? 'SILVER' : 'BRONZE' }

/** Advisory content grade (ADR 0057). Weights sum to 100 so the score is a plain percentage; it never gates publication. */
export function assessContentQuality(f: QualityFacts): HotelContentQuality {
  const met: Record<HotelQualitySignalKey, boolean> = {
    FULL_DESCRIPTION: len(f.fullDescription) >= 200,
    SHORT_DESCRIPTION_LENGTH: len(f.shortDescription) >= 40,
    PRIMARY_IMAGE: f.hasPrimaryImage,
    GALLERY: f.imageCount >= 5,
    AMENITIES: f.amenityCount >= 5,
    LANGUAGES: f.languages.length > 0,
    POLICIES: f.policyCount >= 3,
    STAR_SOURCE: present(f.starSource),
    EXTERNAL_ID: f.externalIdentifierCount > 0,
    POSTAL_AREA: present(f.postalCode) && present(f.area),
    CHAIN_BRAND: present(f.chainName) || present(f.brandName),
  }
  const signals = HOTEL_QUALITY_SIGNALS.map((s) => ({ key: s.key, label: s.label, weight: s.weight, tab: s.tab, met: met[s.key] }))
  const score = signals.reduce((sum, s) => sum + (s.met ? s.weight : 0), 0)
  return { score, tier: tierFor(score), signals }
}
