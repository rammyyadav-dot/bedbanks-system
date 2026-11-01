import { estimateLocalCharge, normaliseLocalCharges, payAtHotel, readLocalCharges } from './local-charges'
import { payAtHotelLines } from '../agent/booking-document.render'

const dirham = { kind: 'TOURISM_DIRHAM', label: 'Tourism Dirham', amountMinor: '2000', currency: 'AED', basis: 'PER_ROOM_PER_NIGHT', maxNights: 30 }

describe('local charges paid at the hotel (ADR 0067, F-04)', () => {
  it('accepts a valid set and normalises currency and amounts', () => {
    const errors: string[] = []
    expect(normaliseLocalCharges([{ ...dirham, currency: 'aed', amountMinor: 2000 }], errors)).toEqual([{ ...dirham }])
    expect(errors).toEqual([])
    expect(normaliseLocalCharges(undefined, errors)).toBeUndefined()
    expect(normaliseLocalCharges([], errors)).toEqual([])
  })

  it('reports every invalid field and keeps none of a bad charge', () => {
    const errors: string[] = []
    const out = normaliseLocalCharges([{ kind: 'VAT', label: '', amountMinor: '-1', currency: 'AE', basis: 'PER_WEEK', maxNights: 0 }, { ...dirham, basis: 'PER_ROOM_PER_STAY' }], errors)
    expect(out).toEqual([])
    expect(errors.map((e) => e.split(':')[0])).toEqual(['localCharges[0].kind', 'localCharges[0].basis', 'localCharges[0].label', 'localCharges[0].amountMinor', 'localCharges[0].currency', 'localCharges[0].maxNights', 'localCharges[1].maxNights'])
    expect(normaliseLocalCharges(new Array(11).fill(dirham), errors)).toBeUndefined()
  })

  it('estimates per room, per person, per stay and caps nights', () => {
    const stay = { nights: 40, rooms: 2, guests: 5 }
    expect(estimateLocalCharge({ ...dirham, basis: 'PER_ROOM_PER_NIGHT' } as never, stay)).toBe(2000n * 30n * 2n)
    expect(estimateLocalCharge({ ...dirham, basis: 'PER_PERSON_PER_NIGHT', maxNights: null } as never, stay)).toBe(2000n * 40n * 5n)
    expect(estimateLocalCharge({ ...dirham, basis: 'PER_ROOM_PER_STAY', maxNights: null } as never, stay)).toBe(4000n)
    expect(estimateLocalCharge({ ...dirham, basis: 'PER_PERSON_PER_STAY', maxNights: null } as never, stay)).toBe(10000n)
  })

  it('reads stored JSON defensively and states charges for offers and documents', () => {
    expect(readLocalCharges('nope')).toEqual([])
    expect(readLocalCharges([{ broken: true }, dirham])).toEqual([dirham])
    const lines = payAtHotel([dirham], { nights: 3, rooms: 1, guests: 2 })
    expect(lines).toEqual([{ kind: 'TOURISM_DIRHAM', label: 'Tourism Dirham', amountMinor: 2000, currency: 'AED', basis: 'PER_ROOM_PER_NIGHT', estimatedTotalMinor: 6000 }])
    expect(payAtHotelLines({ payAtHotel: [{ ...lines[0], amountMinor: '2000', estimatedTotalMinor: '6000' }] })).toEqual(['Tourism Dirham: AED 20.00 per room per night (about AED 60.00 for this stay)'])
    expect(payAtHotelLines({})).toEqual([])
  })
})
