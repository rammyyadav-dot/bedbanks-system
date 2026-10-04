import { BadRequestException } from '@nestjs/common'
import { complianceReviewRequired, duties, secondApprovalRequired, validateDeclaration, type DutyState } from './funding-policy'

const now = new Date('2026-10-04T10:00:00.000Z')
const body = (over: Record<string, unknown> = {}) => ({
  currency: 'AED', amountMinor: '1000000', method: 'BANK_TRANSFER', bankReference: ' ft26277abc ', valueDate: '2026-10-03',
  payerName: '  Gulf  Travel LLC ', payerType: 'AGENCY', requestId: 'req-12345678', ...over,
})
const base: DutyState = { status: 'DECLARED', declaredById: 'alice', verifiedById: null, complianceReviewRequired: false, complianceClearedById: null, secondApprovalRequired: false }

describe('funding policy (ADR 0028 slice 2)', () => {
  const saved = process.env.SETTLEMENT_CURRENCIES
  beforeAll(() => { process.env.SETTLEMENT_CURRENCIES = 'AED' })
  afterAll(() => { if (saved === undefined) delete process.env.SETTLEMENT_CURRENCIES; else process.env.SETTLEMENT_CURRENCIES = saved })

  it('normalises a valid declaration: canonical reference, collapsed payer name, flags derived by the server', () => {
    const v = validateDeclaration(body(), now)
    expect(v).toMatchObject({ currency: 'AED', amountMinor: 1_000_000n, bankReference: 'FT26277ABC', payerName: 'Gulf Travel LLC', complianceReviewRequired: false, secondApprovalRequired: false })
    expect(v.valueDate.toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })

  it('second approval: AED 10,000.00 exactly does not need one, one fil more does; an unconfigured currency always does', () => {
    expect(secondApprovalRequired('AED', 1_000_000n)).toBe(false)
    expect(secondApprovalRequired('AED', 1_000_001n)).toBe(true)
    expect(secondApprovalRequired('USD', 1n)).toBe(true)
  })

  it('compliance review: cash or a third-party payer', () => {
    expect(complianceReviewRequired('BANK_TRANSFER', 'AGENCY')).toBe(false)
    expect(complianceReviewRequired('CASH_DEPOSIT', 'AGENCY')).toBe(true)
    expect(complianceReviewRequired('BANK_TRANSFER', 'THIRD_PARTY')).toBe(true)
  })

  it.each([
    ['zero amount', { amountMinor: '0' }], ['negative', { amountMinor: '-5' }], ['decimal', { amountMinor: '10.50' }], ['number not string', { amountMinor: 100 }],
    ['currency not enabled', { currency: 'USD' }], ['bad method', { method: 'CARD' }], ['bad payer type', { payerType: 'OTHER' }],
    ['empty reference', { bankReference: '   ' }], ['long reference', { bankReference: 'x'.repeat(81) }], ['control chars', { payerName: 'a\u0007b' }],
    ['impossible date', { valueDate: '2026-02-31' }], ['future date', { valueDate: '2026-10-06' }], ['too old', { valueDate: '2025-09-01' }],
    ['short requestId', { requestId: 'abc' }],
  ])('rejects %s', (_label, over) => {
    expect(() => validateDeclaration(body(over), now)).toThrow(BadRequestException)
  })

  it('separation of duties: the declarer never verifies, clears or posts; above the threshold the verifier cannot post', () => {
    expect(duties.verify(base, 'alice')?.kind).toBe('duty')
    expect(duties.verify(base, 'bob')).toBeNull()
    const verified = { ...base, status: 'VERIFIED', verifiedById: 'bob' }
    expect(duties.post(verified, 'alice')?.kind).toBe('duty')
    expect(duties.post(verified, 'bob')).toBeNull()
    expect(duties.post({ ...verified, secondApprovalRequired: true }, 'bob')?.kind).toBe('duty')
    expect(duties.post({ ...verified, secondApprovalRequired: true }, 'carol')).toBeNull()
  })

  it('compliance: required receipts cannot post until cleared, by someone other than the declarer', () => {
    const cash = { ...base, status: 'VERIFIED', verifiedById: 'bob', complianceReviewRequired: true }
    expect(duties.post(cash, 'bob')).toEqual({ kind: 'state', message: 'The compliance review must be cleared before posting' })
    expect(duties.clearCompliance(cash, 'alice')?.kind).toBe('duty')
    expect(duties.clearCompliance(cash, 'bob')).toBeNull()
    expect(duties.post({ ...cash, complianceClearedById: 'bob' }, 'bob')).toBeNull()
    expect(duties.clearCompliance(base, 'bob')?.kind).toBe('state')
  })

  it('state: only declared or verified receipts can be rejected; posted and rejected ones are final', () => {
    expect(duties.reject(base)).toBeNull()
    expect(duties.reject({ ...base, status: 'POSTED' })?.kind).toBe('state')
    expect(duties.verify({ ...base, status: 'REJECTED' }, 'bob')?.kind).toBe('state')
    expect(duties.post(base, 'bob')?.kind).toBe('state')
  })
})
