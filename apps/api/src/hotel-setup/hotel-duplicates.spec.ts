import { distanceMetres, findPossibleDuplicates, nameSimilarity, nameTokens, type DuplicateSubject } from './hotel-duplicates'

const base: DuplicateSubject = { id: 'h1', name: 'Palm View Hotel', city: 'Dubai', countryCode: 'AE', postalCode: null, latitude: 25.1, longitude: 55.2, status: 'DRAFT', externalIds: [] }
const other = (p: Partial<DuplicateSubject>): DuplicateSubject => ({ ...base, id: 'h2', ...p })

describe('name matching', () => {
  it('drops generic words, accents and punctuation', () => {
    expect(nameTokens('The Palm-View Hôtel & Spa')).toEqual(['palm', 'view'])
    expect(nameSimilarity('The Palm View Hotel & Spa', 'Palm View')).toBe(1)
    expect(nameSimilarity('Palm View', 'Marina Bay')).toBe(0)
  })
  it('does not treat an all-generic name as empty', () => { expect(nameTokens('The Hotel')).toEqual(['the', 'hotel']) })
})

describe('distanceMetres', () => {
  it('is zero for the same point and about 111 km per degree of latitude', () => {
    expect(distanceMetres(25, 55, 25, 55)).toBe(0)
    expect(Math.round(distanceMetres(25, 55, 26, 55) / 1000)).toBe(111)
  })
})

describe('findPossibleDuplicates', () => {
  it('flags a similar name within the radius', () => {
    const r = findPossibleDuplicates(base, [other({ name: 'Palm View', latitude: 25.1005, longitude: 55.2 })])
    expect(r).toHaveLength(1); expect(r[0].basis).toEqual(['NEAR_LOCATION_SIMILAR_NAME']); expect(r[0].distanceMetres).toBeLessThanOrEqual(150)
  })
  it('does not flag a similar name far away, a different name nearby, another country or itself', () => {
    expect(findPossibleDuplicates(base, [
      other({ id: 'far', name: 'Palm View', latitude: 25.2 }), other({ id: 'diff', name: 'Marina Bay', latitude: 25.1 }),
      other({ id: 'cc', name: 'Palm View', countryCode: 'OM' }), { ...base },
    ])).toEqual([])
  })
  it('flags a shared external identifier even with a different name and no coordinates, ranked first', () => {
    const r = findPossibleDuplicates({ ...base, externalIds: ['GIATA:1'] }, [other({ id: 'near', name: 'Palm View', latitude: 25.1 }), other({ id: 'gi', name: 'Completely Different', latitude: null, longitude: null, externalIds: ['GIATA:1'] })])
    expect(r.map((x) => x.hotelId)).toEqual(['gi', 'near']); expect(r[0].basis).toEqual(['SAME_EXTERNAL_ID']); expect(r[0].distanceMetres).toBeNull()
  })
  it('falls back to the same postal code and city when coordinates are missing', () => {
    const s = { ...base, latitude: null, longitude: null, postalCode: ' 12345 ' }
    expect(findPossibleDuplicates(s, [other({ name: 'Palm View', latitude: null, longitude: null, postalCode: '12345' })])[0].basis).toEqual(['SAME_POSTAL_SIMILAR_NAME'])
  })
  it('caps the result', () => { expect(findPossibleDuplicates(base, Array.from({ length: 9 }, (_, i) => other({ id: `d${i}`, name: 'Palm View' })), 3)).toHaveLength(3) })
})
