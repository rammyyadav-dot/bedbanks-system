import { HOTEL_QUALITY_SIGNALS } from '@bedbanks/contracts'
import { assessContentQuality, tierFor, type QualityFacts } from './hotel-content-quality'

const empty: QualityFacts = { shortDescription: null, fullDescription: null, languages: [], starSource: null, postalCode: null, area: null, chainName: null, brandName: null, policyCount: 0, externalIdentifierCount: 0, imageCount: 0, hasPrimaryImage: false, amenityCount: 0 }
const full: QualityFacts = { shortDescription: 'A quiet beachfront hotel on the Palm with sea views.', fullDescription: 'x'.repeat(200), languages: ['en'], starSource: 'Dubai DET', postalCode: '00000', area: 'Palm Jumeirah', chainName: 'Acme', brandName: null, policyCount: 3, externalIdentifierCount: 1, imageCount: 5, hasPrimaryImage: true, amenityCount: 5 }

describe('assessContentQuality', () => {
  it('weights sum to 100 so the score is a percentage', () => { expect(HOTEL_QUALITY_SIGNALS.reduce((s, x) => s + x.weight, 0)).toBe(100) })
  it('grades an empty profile 0 / BRONZE and a complete one 100 / GOLD', () => {
    expect(assessContentQuality(empty)).toMatchObject({ score: 0, tier: 'BRONZE' })
    expect(assessContentQuality(full)).toMatchObject({ score: 100, tier: 'GOLD' })
  })
  it('applies thresholds at their boundaries and ignores whitespace', () => {
    const q = assessContentQuality({ ...full, fullDescription: ' '.repeat(300) + 'x'.repeat(199), imageCount: 4, amenityCount: 4, policyCount: 2, shortDescription: 'x'.repeat(39) })
    const met = Object.fromEntries(q.signals.map((s) => [s.key, s.met]))
    expect(met).toMatchObject({ FULL_DESCRIPTION: false, GALLERY: false, AMENITIES: false, POLICIES: false, SHORT_DESCRIPTION_LENGTH: false, PRIMARY_IMAGE: true })
  })
  it('requires both postal code and area, and accepts brand without chain', () => {
    const met = (f: Partial<QualityFacts>) => Object.fromEntries(assessContentQuality({ ...empty, ...f }).signals.map((s) => [s.key, s.met]))
    expect(met({ postalCode: '1' }).POSTAL_AREA).toBe(false)
    expect(met({ brandName: 'B' }).CHAIN_BRAND).toBe(true)
  })
  it('maps tiers at 50 and 80', () => { expect([49, 50, 79, 80].map(tierFor)).toEqual(['BRONZE', 'SILVER', 'SILVER', 'GOLD']) })
})
