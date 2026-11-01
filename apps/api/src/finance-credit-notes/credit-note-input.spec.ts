import { BadRequestException } from '@nestjs/common'
import { parseCreditNoteProposal, parseDecisionReason } from './credit-note-input'

const ok = { requestId: 'req-12345678', bookingId: 'bk_1', amountMinor: '2500', reason: 'SUPPLIER_SERVICE_FAILURE', note: 'Hotel relocated the guests' }

describe('parseCreditNoteProposal', () => {
  it('accepts a valid proposal and returns the amount as a bigint', () => {
    expect(parseCreditNoteProposal(ok)).toEqual({ requestId: 'req-12345678', bookingId: 'bk_1', amountMinor: 2500n, reason: 'SUPPLIER_SERVICE_FAILURE', note: 'Hotel relocated the guests' })
  })
  it.each([
    ['no body', null], ['an array', []], ['short requestId', { ...ok, requestId: 'short' }], ['requestId with a space', { ...ok, requestId: 'req 12345678' }], ['no bookingId', { ...ok, bookingId: '' }],
    ['a JSON number amount', { ...ok, amountMinor: 2500 }], ['a decimal amount', { ...ok, amountMinor: '25.00' }], ['zero', { ...ok, amountMinor: '0' }], ['a negative amount', { ...ok, amountMinor: '-5' }],
    ['a leading zero', { ...ok, amountMinor: '0100' }], ['19 digits', { ...ok, amountMinor: '1000000000000000000' }], ['an unknown reason', { ...ok, reason: 'REFUND_ME' }],
    ['a short note', { ...ok, note: 'hi' }], ['a control character in the note', { ...ok, note: 'bad\u0000note' }], ['a long note', { ...ok, note: 'x'.repeat(501) }],
  ])('refuses %s with a 400 and the stable code', (_name, body) => {
    expect(() => parseCreditNoteProposal(body)).toThrow(BadRequestException)
    try { parseCreditNoteProposal(body) } catch (e) { expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'CREDIT_NOTE_INVALID' }) }
  })
  it('keeps the largest 18-digit amount exactly (no floating point)', () => {
    expect(parseCreditNoteProposal({ ...ok, amountMinor: '999999999999999999' }).amountMinor).toBe(999999999999999999n)
  })
})

describe('parseDecisionReason', () => {
  it('needs 3 to 500 printable characters', () => {
    expect(parseDecisionReason({ reason: '  Not supported by the supplier  ' })).toBe('Not supported by the supplier')
    for (const body of [undefined, {}, { reason: 'no' }, { reason: 'x'.repeat(501) }, { reason: 7 }]) expect(() => parseDecisionReason(body)).toThrow(BadRequestException)
  })
})
