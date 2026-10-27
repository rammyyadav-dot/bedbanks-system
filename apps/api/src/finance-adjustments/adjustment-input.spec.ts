import { BadRequestException } from '@nestjs/common'
import { parseAdjustmentDecisionReason, parseLedgerAdjustmentProposal } from './adjustment-input'

const fee = { requestId: 'req-12345678', kind: 'ADJUSTMENT', agencyId: 'ag_1', currency: 'AED', direction: 'DEBIT', amountMinor: '2500', reason: 'BANK_FEE', note: 'Incoming transfer fee' }
const recall = { requestId: 'req-87654321', kind: 'REVERSAL', agencyId: 'ag_1', currency: 'AED', amountMinor: '10000', reason: 'PAYMENT_RECALL', note: 'Bank recalled the transfer', fundingReceiptId: 'fr_1' }

describe('parseLedgerAdjustmentProposal', () => {
  it('stores a debit adjustment negative and a credit adjustment positive, as bigint', () => {
    expect(parseLedgerAdjustmentProposal(fee)).toMatchObject({ kind: 'ADJUSTMENT', signedAmountMinor: -2500n, direction: 'DEBIT', fundingReceiptId: null })
    expect(parseLedgerAdjustmentProposal({ ...fee, direction: 'CREDIT', reason: 'GOODWILL' })).toMatchObject({ signedAmountMinor: 2500n, direction: 'CREDIT' })
  })
  it('stores a reversal negative and names its receipt', () => {
    expect(parseLedgerAdjustmentProposal(recall)).toMatchObject({ kind: 'REVERSAL', signedAmountMinor: -10000n, direction: 'DEBIT', fundingReceiptId: 'fr_1' })
  })
  it.each([
    ['no body', null], ['an array', []], ['short requestId', { ...fee, requestId: 'short' }], ['an unknown kind', { ...fee, kind: 'REFUND' }], ['no agency', { ...fee, agencyId: '' }],
    ['a lowercase currency', { ...fee, currency: 'aed' }], ['a JSON number amount', { ...fee, amountMinor: 2500 }], ['a decimal amount', { ...fee, amountMinor: '25.00' }], ['zero', { ...fee, amountMinor: '0' }],
    ['a negative amount', { ...fee, amountMinor: '-5' }], ['19 digits', { ...fee, amountMinor: '1000000000000000000' }], ['an adjustment without a direction', { ...fee, direction: undefined }],
    ['a sideways direction', { ...fee, direction: 'UP' }], ['a reversal reason on an adjustment', { ...fee, reason: 'CHARGEBACK' }], ['an adjustment reason on a reversal', { ...recall, reason: 'BANK_FEE' }],
    ['a short note', { ...fee, note: 'hi' }], ['a control character in the note', { ...fee, note: 'bad\u0000note' }], ['a long note', { ...fee, note: 'x'.repeat(501) }],
    ['an adjustment naming a receipt', { ...fee, fundingReceiptId: 'fr_1' }], ['a reversal without a receipt', { ...recall, fundingReceiptId: undefined }],
    ['a reversal choosing a direction', { ...recall, direction: 'CREDIT' }],
  ])('refuses %s with a 400 and the stable code', (_name, body) => {
    expect(() => parseLedgerAdjustmentProposal(body)).toThrow(BadRequestException)
    try { parseLedgerAdjustmentProposal(body) } catch (e) { expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'LEDGER_ADJUSTMENT_INVALID' }) }
  })
  it('keeps the largest 18-digit amount exactly (no floating point)', () => {
    expect(parseLedgerAdjustmentProposal({ ...fee, amountMinor: '999999999999999999' }).signedAmountMinor).toBe(-999999999999999999n)
  })
})

describe('parseAdjustmentDecisionReason', () => {
  it('needs 3 to 500 printable characters', () => {
    expect(parseAdjustmentDecisionReason({ reason: '  Not supported by the bank advice  ' })).toBe('Not supported by the bank advice')
    for (const body of [undefined, {}, { reason: 'no' }, { reason: 'x'.repeat(501) }, { reason: 7 }]) expect(() => parseAdjustmentDecisionReason(body)).toThrow(BadRequestException)
  })
})
