import { mergeBedding, mergedOccupancyProblems, normaliseAmenities, normaliseRoomSave, parseBedding } from './hotel-room-rules'
import { occupancyProblems } from '../supply/room-rules'

describe('occupancyProblems (shared with the supply API)', () => {
  it('accepts the canonical rule and names each broken part', () => {
    expect(occupancyProblems(2, 1, 3)).toEqual([])
    expect(occupancyProblems(2, 0, 2)).toEqual([])
    expect(occupancyProblems(0, 0, 1)[0]).toMatch(/maxAdults/)
    expect(occupancyProblems(2, -1, 2)[0]).toMatch(/maxChildren/)
    expect(occupancyProblems(2, 2, 3)[0]).toMatch(/at least maxAdults plus maxChildren/)
    expect(occupancyProblems(2.5, 0, 3)[0]).toMatch(/maxAdults/)
    expect(occupancyProblems(2, 0, '3')[0]).toMatch(/maxOccupancy/)
  })
})

describe('bedding', () => {
  it('parses the known keys and ignores anything malformed', () => {
    expect(parseBedding({ description: 'King', beds: [{ type: 'KING', count: 1 }, { type: 'WATERBED', count: 1 }, { type: 'TWIN', count: 0 }], extraBed: 'SUPPORTED', legacy: 'x' })).toEqual({ description: 'King', beds: [{ type: 'KING', count: 1 }], extraBed: 'SUPPORTED' })
    expect(parseBedding(null)).toEqual({ description: null, beds: [], extraBed: 'UNKNOWN' })
    expect(parseBedding([])).toEqual({ description: null, beds: [], extraBed: 'UNKNOWN' })
  })
  it('merges known keys and preserves every other stored key', () => {
    expect(mergeBedding({ legacy: 'keep', description: 'old' }, { description: 'new', extraBed: 'NOT_SUPPORTED' })).toEqual({ legacy: 'keep', description: 'new', extraBed: 'NOT_SUPPORTED' })
    expect(mergeBedding({ legacy: 'keep', description: 'old', beds: [{ type: 'KING', count: 1 }] }, { description: null, beds: [] })).toEqual({ legacy: 'keep' })
    expect(mergeBedding(undefined, { description: 'x' })).toEqual({ description: 'x' })
  })
})

describe('amenity catalogue scope', () => {
  it('accepts hotel and both-scope codes at hotel level and room and both-scope codes at room level', () => {
    const e1: string[] = []; expect(normaliseAmenities([{ code: 'POOL', feeType: 'FREE' }, { code: 'WIFI', feeType: 'PAID' }], 'HOTEL', e1)).toHaveLength(2); expect(e1).toEqual([])
    const e2: string[] = []; expect(normaliseAmenities([{ code: 'BALCONY', feeType: 'FREE' }, { code: 'WIFI', feeType: 'UNKNOWN' }], 'ROOM', e2)).toHaveLength(2); expect(e2).toEqual([])
  })
  it('rejects the wrong scope, unknown codes, bad fees and duplicates', () => {
    const e: string[] = []
    normaliseAmenities([{ code: 'BALCONY', feeType: 'FREE' }, { code: 'NOPE', feeType: 'FREE' }, { code: 'POOL', feeType: 'MAYBE' }, { code: 'GYM', feeType: 'FREE' }, { code: 'GYM', feeType: 'FREE' }], 'HOTEL', e)
    expect(e).toHaveLength(4)
    expect(e.join(' ')).toMatch(/amenities\[0\]\.code/); expect(e.join(' ')).toMatch(/amenities\[2\]\.feeType/); expect(e.join(' ')).toMatch(/selected more than once/)
  })
})

describe('normaliseRoomSave', () => {
  it('requires the identifying fields on create but not on update', () => {
    expect(normaliseRoomSave({}, 'create').errors.join(' ')).toMatch(/name: is required.*code: is required.*maxAdults: is required.*maxOccupancy: is required/)
    expect(normaliseRoomSave({ name: 'Only a name' }, 'update').errors).toEqual([])
  })
  it('rejects unknown fields, bad codes and bedding, without echoing values', () => {
    const { errors } = normaliseRoomSave({ name: 'x', code: 'bad code', bedding: { beds: [{ type: 'WATERBED', count: 1 }, { type: 'KING', count: 10 }], extraBed: 'MAYBE', mystery: 1 }, hotelId: 'other' } as never, 'update')
    const text = errors.join(' | ')
    expect(text).toMatch(/code:/); expect(text).toMatch(/bedding.beds\[0\].type/); expect(text).toMatch(/bedding.beds\[1\].count/); expect(text).toMatch(/bedding.extraBed/); expect(text).toMatch(/bedding.mystery/); expect(text).toMatch(/hotelId: is not a supported field/)
    expect(text).not.toContain('other')
  })
  it('lists only the fields that were sent', () => {
    const { data } = normaliseRoomSave({ name: ' Deluxe ', maxAdults: 3 }, 'update')
    expect(data.fields).toEqual({ name: 'Deluxe', maxAdults: 3 }); expect(data.changed.sort()).toEqual(['maxAdults', 'name'])
  })
  it('checks occupancy against the stored room for a partial update', () => {
    expect(mergedOccupancyProblems({ maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }, { maxOccupancy: 2 })[0]).toMatch(/at least maxAdults plus maxChildren/)
    expect(mergedOccupancyProblems({ maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }, { maxAdults: 1 })).toEqual([])
  })
})
