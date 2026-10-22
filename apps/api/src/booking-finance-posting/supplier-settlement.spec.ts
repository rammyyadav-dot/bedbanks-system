import { BadRequestException } from '@nestjs/common'
import { parseProposal } from './supplier-settlement.service'

const NOW = new Date('2026-10-21T15:00:00.000Z')
const ok = { supplierId: 's1', currency: 'AED', amountMinor: '12500', paidOn: '2026-10-20', paymentReference: 'WIRE-0001', requestId: 'req-00000001' }
const refuses = (over: Record<string, unknown>) => expect(() => parseProposal({ ...ok, ...over }, NOW)).toThrow(BadRequestException)

describe('supplier settlement proposal validation (ADR 0077)', () => {
  it('accepts a valid proposal and normalises it', () => {
    expect(parseProposal({ ...ok, note: '  March statement  ' }, NOW)).toEqual({ supplierId: 's1', currency: 'AED', amountMinor: 12500n, paidOn: new Date('2026-10-20T00:00:00.000Z'), paymentReference: 'WIRE-0001', note: 'March statement', requestId: 'req-00000001' })
  })
  it('accepts today as the payment date', () => expect(parseProposal({ ...ok, paidOn: '2026-10-21' }, NOW).paidOn).toEqual(new Date('2026-10-21T00:00:00.000Z')))
  it('refuses a future date, a malformed date and an impossible date', () => { refuses({ paidOn: '2026-10-22' }); refuses({ paidOn: '21/10/2026' }); refuses({ paidOn: '2026-02-30' }) })
  it('refuses amounts that are not positive whole minor units: zero, negative, decimal, exponent, number type, empty', () => {
    for (const amountMinor of ['0', '-5', '12.5', '1e3', ' ', '', 12500, null, '0012']) refuses({ amountMinor })
  })
  it('refuses a bad currency, a missing supplier, a short or long reference, a short request id and a long note', () => {
    refuses({ currency: 'aed' }); refuses({ currency: 'AEDX' }); refuses({ supplierId: '  ' }); refuses({ paymentReference: 'ab' }); refuses({ paymentReference: 'x'.repeat(81) })
    refuses({ requestId: 'short' }); refuses({ note: 'n'.repeat(501) }); refuses({ note: 42 })
  })
  it('refuses a missing or non-object body', () => { for (const body of [undefined, null, 'x', 5]) expect(() => parseProposal(body, NOW)).toThrow(BadRequestException) })
  it('keeps a very large amount exact as a bigint, never a float', () => expect(parseProposal({ ...ok, amountMinor: '999999999999999999' }, NOW).amountMinor).toBe(999_999_999_999_999_999n))
})
