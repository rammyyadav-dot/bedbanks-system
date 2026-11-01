import { BadRequestException } from '@nestjs/common'
import { parseCommissionPayoutProposal, parseDecisionReason } from './commission-payout-input'

const ok = { requestId: 'req-12345678', agencyId: 'ag_1', periodStart: '2026-09-01', periodEnd: '2026-10-01', currency: 'AED', grossBookedMinor: '5000000' }

describe('parseCommissionPayoutProposal', () => {
  it('accepts a valid proposal and returns the volume as a bigint', () => {
    expect(parseCommissionPayoutProposal(ok)).toEqual({ requestId: 'req-12345678', agencyId: 'ag_1', periodStart: '2026-09-01', periodEnd: '2026-10-01', currency: 'AED', grossBookedMinor: 5_000_000n })
  })
  it('uppercases the currency', () => {
    expect(parseCommissionPayoutProposal({ ...ok, currency: 'aed' }).currency).toBe('AED')
  })
  it('accepts zero volume', () => {
    expect(parseCommissionPayoutProposal({ ...ok, grossBookedMinor: '0' }).grossBookedMinor).toBe(0n)
  })
  it.each([
    ['no body', null], ['an array', []], ['short requestId', { ...ok, requestId: 'short' }], ['no agencyId', { ...ok, agencyId: '' }],
    ['periodEnd before periodStart', { ...ok, periodStart: '2026-10-01', periodEnd: '2026-09-01' }], ['equal periods', { ...ok, periodStart: '2026-09-01', periodEnd: '2026-09-01' }],
    ['a malformed date', { ...ok, periodStart: '2026/09/01' }], ['a 2-letter currency', { ...ok, currency: 'AE' }], ['a lowercase-after-trim currency with digits', { ...ok, currency: 'A3D' }],
    ['a JSON number volume', { ...ok, grossBookedMinor: 5_000_000 }], ['a decimal volume', { ...ok, grossBookedMinor: '5000000.00' }], ['a negative volume', { ...ok, grossBookedMinor: '-1' }],
    ['a leading zero', { ...ok, grossBookedMinor: '0100' }], ['19 digits', { ...ok, grossBookedMinor: '1000000000000000000' }],
  ])('refuses %s with a 400 and the stable code', (_name, body) => {
    expect(() => parseCommissionPayoutProposal(body)).toThrow(BadRequestException)
    try { parseCommissionPayoutProposal(body) } catch (e) { expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'COMMISSION_PAYOUT_INVALID' }) }
  })
  it('keeps the largest 18-digit volume exactly (no floating point)', () => {
    expect(parseCommissionPayoutProposal({ ...ok, grossBookedMinor: '999999999999999999' }).grossBookedMinor).toBe(999999999999999999n)
  })
})

describe('parseDecisionReason', () => {
  it('needs 3 to 500 printable characters', () => {
    expect(parseDecisionReason({ reason: '  Volume disputed  ' })).toBe('Volume disputed')
    for (const body of [undefined, {}, { reason: 'no' }, { reason: 'x'.repeat(501) }, { reason: 7 }]) expect(() => parseDecisionReason(body)).toThrow(BadRequestException)
  })
})
