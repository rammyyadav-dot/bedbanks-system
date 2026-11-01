import type { HotelCommercialRow } from '@bedbanks/contracts'
import { HOTEL_EXPORT_COLUMNS, csvCell, hotelCsv } from './hotel-export'

describe('hotel export CSV', () => {
  it('neutralizes spreadsheet formulas and quotes special characters', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe("'+1"); expect(csvCell('-2')).toBe("'-2"); expect(csvCell('@a')).toBe("'@a"); expect(csvCell('\tx')).toBe("'\tx")
    expect(csvCell('Hotel, "Arts"')).toBe('"Hotel, ""Arts"""')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell(null)).toBe(''); expect(csvCell(4)).toBe('4')
  })
  it('exports only directory columns', () => {
    const row = { id: 'h1', name: '=cmd', code: null, countryCode: 'AE', city: 'Dubai', propertyType: 'HOTEL', starRating: 5, contentStatus: 'COMPLETE', hotelMapping: 'MAPPED', verifiedMappings: 1, rooms: { total: 3, active: 2, mapped: 2 }, contractState: 'ACTIVE', rates: 'OK', inventory: 'OK', readiness: 'READY', issues: { total: 0, critical: 0, high: 0, warning: 0 }, updatedAt: '2026-10-11T00:00:00.000Z', profile: { owner: 'secret@example.com' } } as unknown as HotelCommercialRow
    const [header, line] = hotelCsv([row]).trim().split('\r\n')
    expect(header!.split(',')).toEqual([...HOTEL_EXPORT_COLUMNS])
    expect(line).toBe("h1,'=cmd,,AE,Dubai,HOTEL,5,COMPLETE,MAPPED,1,2,ACTIVE,OK,OK,READY,0,2026-10-11T00:00:00.000Z")
    expect(hotelCsv([row])).not.toContain('secret')
  })
})
