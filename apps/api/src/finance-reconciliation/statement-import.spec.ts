import { BadRequestException } from '@nestjs/common'
import { validateStatementImport } from './statement-import'

const line = (over: Record<string, unknown> = {}) => ({ reference: 'BK-1', kind: 'CHARGE', currency: 'AED', amount: '100.50', ...over })
const body = (over: Record<string, unknown> = {}) => ({ supplierId: 'sup1', statementRef: 'INV-1', periodStart: '2026-10-01', periodEnd: '2026-10-31', requestId: 'req-12345678', lines: [line()], ...over })

describe('validateStatementImport', () => {
  it('converts major-unit strings with the currency exponent, never a float', () => {
    const v = validateStatementImport(body({ lines: [line(), line({ reference: 'BK-2', currency: 'JPY', amount: '5000' }), line({ reference: 'BK-3', currency: 'KWD', amount: '1.234' })] }))
    expect(v.lines.map((l) => l.amountMinor)).toEqual([10050n, 5000n, 1234n])
    expect(v.lines.map((l) => l.lineNo)).toEqual([1, 2, 3])
  })

  it.each([
    ['a JSON number amount', { lines: [line({ amount: 100.5 })] }],
    ['extra decimals', { lines: [line({ amount: '1.005' })] }],
    ['zero', { lines: [line({ amount: '0.00' })] }],
    ['negative', { lines: [line({ amount: '-5' })] }],
    ['unsupported currency', { lines: [line({ currency: 'XXX' })] }],
    ['lowercase currency', { lines: [line({ currency: 'aed' })] }],
    ['unknown kind', { lines: [line({ kind: 'REFUND' })] }],
    ['blank reference', { lines: [line({ reference: '  ' })] }],
    ['control character in reference', { lines: [line({ reference: 'BK\n1' })] }],
    ['no lines', { lines: [] }],
    ['too many lines', { lines: Array.from({ length: 5001 }, (_, i) => line({ reference: `B${i}` })) }],
    ['reversed period', { periodStart: '2026-11-01' }],
    ['impossible date', { periodEnd: '2026-02-31' }],
    ['a period over 400 days', { periodStart: '2025-01-01', periodEnd: '2026-12-31' }],
    ['short requestId', { requestId: 'short' }],
    ['missing supplier', { supplierId: undefined }],
  ])('refuses %s', (_n, over) => {
    expect(() => validateStatementImport(body(over))).toThrow(BadRequestException)
  })

  it('refuses a non-object body', () => {
    expect(() => validateStatementImport(null)).toThrow(BadRequestException)
    expect(() => validateStatementImport([])).toThrow(BadRequestException)
  })

  it('hashes the content independent of line order and reference case, and sensitive to amount and period', () => {
    const a = validateStatementImport(body({ lines: [line(), line({ reference: 'BK-2', amount: '5' })] }))
    const reordered = validateStatementImport(body({ lines: [line({ reference: 'bk-2', amount: '5' }), line({ reference: ' bk-1 ' })] }))
    expect(reordered.contentSha256).toBe(a.contentSha256)
    expect(a.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(validateStatementImport(body({ lines: [line({ amount: '100.51' }), line({ reference: 'BK-2', amount: '5' })] })).contentSha256).not.toBe(a.contentSha256)
    expect(validateStatementImport(body({ periodEnd: '2026-10-30', lines: [line(), line({ reference: 'BK-2', amount: '5' })] })).contentSha256).not.toBe(a.contentSha256)
  })
})
