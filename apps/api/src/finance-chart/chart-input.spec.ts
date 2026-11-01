import { BadRequestException } from '@nestjs/common'
import { parseAccountCreate, parseMappingSet, parseMonth } from './chart-input'

describe('parseAccountCreate', () => {
  it('accepts a valid account and trims it', () => expect(parseAccountCreate({ code: ' 2100 ', name: ' Agency balances ', type: 'LIABILITY' })).toEqual({ code: '2100', name: 'Agency balances', type: 'LIABILITY' }))
  it.each([['no body', null], ['an empty code', { code: '', name: 'Bank', type: 'ASSET' }], ['a code with a space', { code: '10 00', name: 'Bank', type: 'ASSET' }], ['a 17 character code', { code: 'a'.repeat(17), name: 'Bank', type: 'ASSET' }],
    ['a one character name', { code: '1000', name: 'B', type: 'ASSET' }], ['a control character', { code: '1000', name: 'Ba\u0000nk', type: 'ASSET' }], ['an unknown type', { code: '1000', name: 'Bank', type: 'CASH' }]])('refuses %s', (_n, body) => {
    expect(() => parseAccountCreate(body)).toThrow(BadRequestException)
    try { parseAccountCreate(body) } catch (e) { expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'FINANCE_CHART_INVALID' }) }
  })
})

describe('parseMappingSet', () => {
  const ok = { category: 'BOOKING_CHARGE', debitAccountId: 'a1', creditAccountId: 'a2' }
  it('accepts a valid mapping', () => expect(parseMappingSet(ok)).toEqual(ok))
  it.each([['an unknown category', { ...ok, category: 'LUNCH' }], ['the same account twice', { ...ok, creditAccountId: 'a1' }], ['no debit account', { ...ok, debitAccountId: '' }], ['no body', undefined]])('refuses %s', (_n, body) => {
    expect(() => parseMappingSet(body)).toThrow(BadRequestException)
  })
})

describe('parseMonth', () => {
  it('needs YYYY-MM', () => { expect(parseMonth('2026-09')).toBe('2026-09'); for (const v of ['2026-13', '2026-9', undefined, 5]) expect(() => parseMonth(v)).toThrow(BadRequestException) })
})
