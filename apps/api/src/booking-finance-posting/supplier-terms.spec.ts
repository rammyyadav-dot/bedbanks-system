import { BadRequestException } from '@nestjs/common'
import { parseTerms } from './supplier-terms.service'

const ok = { supplierId: 's1', basis: 'CHECK_OUT', days: 30 }
const refuses = (over: Record<string, unknown>) => expect(() => parseTerms({ ...ok, ...over })).toThrow(BadRequestException)

describe('supplier payment terms validation (ADR 0078)', () => {
  it('accepts each basis and the limits 0 and 365', () => {
    for (const basis of ['CHECK_OUT', 'CHECK_IN', 'CONFIRMATION']) expect(parseTerms({ ...ok, basis }).basis).toBe(basis)
    expect(parseTerms({ ...ok, days: 0 }).days).toBe(0)
    expect(parseTerms({ ...ok, days: 365 }).days).toBe(365)
  })
  it('normalises the note', () => { expect(parseTerms({ ...ok, note: '  Net 30 per contract  ' }).note).toBe('Net 30 per contract'); expect(parseTerms({ ...ok, note: '  ' }).note).toBeNull() })
  it('refuses a bad basis, fractional, negative, too large, string and missing days', () => {
    refuses({ basis: 'CHECKOUT' }); refuses({ basis: undefined }); refuses({ days: 30.5 }); refuses({ days: -1 }); refuses({ days: 366 }); refuses({ days: '30' }); refuses({ days: undefined })
  })
  it('refuses a missing supplier, a long note and a missing body', () => {
    refuses({ supplierId: ' ' }); refuses({ note: 'n'.repeat(501) }); refuses({ note: 7 })
    for (const body of [undefined, null, 'x']) expect(() => parseTerms(body)).toThrow(BadRequestException)
  })
})
