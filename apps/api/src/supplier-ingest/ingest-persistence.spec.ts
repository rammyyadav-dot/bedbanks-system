import { hashResult, summarizeRejects } from './ingest-persistence'

const rate = (date: string, net: number) => ({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: 'BAR', boardCode: null, stayDate: date, currency: 'AED', netMinor: net, taxesIncluded: null, minStay: null, maxStay: null, closedToArrival: false, closedToDeparture: false })
const result = (accepted: ReturnType<typeof rate>[]) => ({ accepted, rejected: [], extracted: accepted.length, status: 'COMPLETE' as const })

describe('ingest persistence helpers', () => {
  it('hashes the same delivery identically regardless of row order, and different content differently', () => {
    const a = hashResult('RATES', result([rate('2027-03-05', 100), rate('2027-03-06', 200)]))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(hashResult('RATES', result([rate('2027-03-06', 200), rate('2027-03-05', 100)]))).toBe(a)
    expect(hashResult('RATES', result([rate('2027-03-05', 100), rate('2027-03-06', 201)]))).not.toBe(a)
    expect(hashResult('ALLOTMENTS', result([rate('2027-03-05', 100), rate('2027-03-06', 200)]))).not.toBe(a)
  })

  it('summarizes rejects as code:field counts, capped, with no row content', () => {
    expect(summarizeRejects([{ kind: 'rate', index: 3, code: 'invalid_amount', field: 'netAmount' }, { kind: 'rate', index: 9, code: 'invalid_amount', field: 'netAmount' }, { kind: 'rate', index: 4, code: 'duplicate_conflict', field: null }]))
      .toEqual({ 'invalid_amount:netAmount': 2, 'duplicate_conflict:-': 1 })
    const many = Array.from({ length: 150 }, (_, i) => ({ kind: 'rate' as const, index: i, code: 'invalid_code' as const, field: `f${i}` }))
    const summary = summarizeRejects(many)
    expect(Object.keys(summary).length).toBe(101)
    expect(summary.other).toBe(50)
  })
})
