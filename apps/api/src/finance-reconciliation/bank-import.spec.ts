import { BadRequestException, UnprocessableEntityException } from '@nestjs/common'
import { BANK_MATCH_TYPE_NAMES } from '@bedbanks/contracts'
import { BANK_MATCH_TYPES } from '@bedbanks/money'
import { prepareBankImport } from './bank-import'

const MT940 = [':20:STMT1', ':25:AE07 0331 2345', ':60F:C261001AED1000,00', ':61:2610021002D250,50NTRFNONREF//B1', ':86:PAY-2026-0042', ':62F:C261001AED749,50', '-'].join('\n')
const body = (over: Record<string, unknown> = {}) => ({ requestId: 'req-12345678', format: 'MT940', content: MT940, ...over })

describe('prepareBankImport (ADR 0093)', () => {
  it('parses, hashes the account with the tenant, keeps only its last four characters and derives the period', () => {
    const p = prepareBankImport('t1', body())
    expect(p).toMatchObject({ format: 'MT940', statementRef: 'STMT1', accountLast4: '2345', currency: 'AED', periodStart: '2026-10-02', periodEnd: '2026-10-02', openingMinor: 100000n, closingMinor: 74950n })
    expect(p.accountSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('AE070331')
    expect(prepareBankImport('t2', body()).accountSha256).not.toBe(p.accountSha256)
  })

  it('the content hash ignores the statement number, so a renamed copy is a duplicate', () => {
    expect(prepareBankImport('t1', body({ content: MT940.replace('STMT1', 'STMT2') })).contentSha256).toBe(prepareBankImport('t1', body()).contentSha256)
    expect(prepareBankImport('t1', body({ content: MT940.replace('250,50', '250,51').replace('749,50', '749,49') })).contentSha256).not.toBe(prepareBankImport('t1', body()).contentSha256)
  })

  it('refuses bad requests with 400 and unreadable statements with a stable 422 code that never echoes content', () => {
    for (const bad of [null, [], body({ requestId: 'short' }), body({ format: 'PDF' }), body({ content: '' }), body({ content: 'x'.repeat(1_500_001) })]) expect(() => prepareBankImport('t1', bad)).toThrow(BadRequestException)
    try { prepareBankImport('t1', body({ content: MT940.replace('749,50', '700,00') })); fail('expected a refusal') } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException)
      expect(JSON.stringify((e as UnprocessableEntityException).getResponse())).toBe(JSON.stringify({ message: 'The bank statement could not be read', code: 'BANK_STATEMENT_BALANCE_MISMATCH' }))
    }
  })

  it('CSV needs its identity from the caller; a file with two statements is refused', () => {
    const csv = 'date,amount,currency,reference\n2026-10-02,-250.50,AED,PAY-2026-0042\n'
    expect(() => prepareBankImport('t1', body({ format: 'CSV', content: csv }))).toThrow(BadRequestException)
    expect(prepareBankImport('t1', body({ format: 'CSV', content: csv, statementRef: 'C1', accountId: 'ACC-9' }))).toMatchObject({ format: 'CSV', openingMinor: null, entries: [{ direction: 'DEBIT', amountMinor: 25050n }] })
    expect(() => prepareBankImport('t1', body({ content: `${MT940}\n${MT940.replace('STMT1', 'STMT2')}` }))).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'BANK_STATEMENT_MULTIPLE' }) }))
  })

  it('contract constants equal the money package match types', () => {
    expect([...BANK_MATCH_TYPE_NAMES]).toEqual([...BANK_MATCH_TYPES])
  })
})
