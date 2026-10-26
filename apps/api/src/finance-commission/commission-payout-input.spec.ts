import { BadRequestException } from '@nestjs/common'
import { parseCommissionPayoutProposal, parseDecisionReason } from './commission-payout-input'

const ok = { requestId: 'req-12345678', agencyId: 'ag_1', periodStart: '2026-09-01', periodEnd: '2026-10-01', currency: 'AED' }

describe('parseCommissionPayoutProposal', () => {
  it('accepts a valid proposal', () => {
    expect(parseCommissionPayoutProposal(ok)).toEqual({ requestId: 'req-12345678', agencyId: 'ag_1', periodStart: '2026-09-01', periodEnd: '2026-10-01', currency: 'AED' })
  })
  it('uppercases the currency', () => {
    expect(parseCommissionPayoutProposal({ ...ok, currency: 'aed' }).currency).toBe('AED')
  })
  it.each([
    ['no body', null], ['an array', []], ['short requestId', { ...ok, requestId: 'short' }], ['no agencyId', { ...ok, agencyId: '' }],
    ['periodEnd before periodStart', { ...ok, periodStart: '2026-10-01', periodEnd: '2026-09-01' }], ['equal periods', { ...ok, periodStart: '2026-09-01', periodEnd: '2026-09-01' }],
    ['a malformed date', { ...ok, periodStart: '2026/09/01' }], ['a 2-letter currency', { ...ok, currency: 'AE' }], ['a lowercase-after-trim currency with digits', { ...ok, currency: 'A3D' }],
  ])('refuses %s with a 400 and the stable code', (_name, body) => {
    expect(() => parseCommissionPayoutProposal(body)).toThrow(BadRequestException)
    try { parseCommissionPayoutProposal(body) } catch (e) { expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'COMMISSION_PAYOUT_INVALID' }) }
  })
  it('does not accept a client-supplied gross volume: a grossBookedMinor field on the body is ignored, never trusted', () => {
    expect(parseCommissionPayoutProposal({ ...ok, grossBookedMinor: '999999999999999999' })).toEqual({ requestId: 'req-12345678', agencyId: 'ag_1', periodStart: '2026-09-01', periodEnd: '2026-10-01', currency: 'AED' })
  })
})

describe('parseDecisionReason', () => {
  it('needs 3 to 500 printable characters', () => {
    expect(parseDecisionReason({ reason: '  Volume disputed  ' })).toBe('Volume disputed')
    for (const body of [undefined, {}, { reason: 'no' }, { reason: 'x'.repeat(501) }, { reason: 7 }]) expect(() => parseDecisionReason(body)).toThrow(BadRequestException)
  })
})
