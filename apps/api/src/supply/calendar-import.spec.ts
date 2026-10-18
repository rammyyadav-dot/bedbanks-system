import { buildCalendarImport, errorsToCsv, MAX_IMPORT_CELLS, parseCsv, type ImportLookups, type ImportPlan } from './calendar-import'

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({ id: 'p1', code: 'BB-DBL', currency: 'AED', occupancy: 2, inventoryPoolId: null, contractValidFrom: '2026-01-01', contractValidTo: '2026-12-31', ...over })
const lookups = (plans: ImportPlan[] = [plan()], over: Partial<ImportLookups> = {}): ImportLookups => {
  const byCode = new Map<string, ImportPlan[]>(); for (const p of plans) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p])
  return { plansByCode: byCode, plansById: new Map(plans.map((p) => [p.id, p])), rate: () => null, availability: () => null, ...over }
}
const csv = (...lines: string[]) => lines.join('\n')
const H = 'plan_code,date,amount,basis'

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, CRLF, a BOM and blank lines', () => {
    const r = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nz,\r\n')
    expect(r).toEqual({ ok: true, rows: [['a', 'b'], ['x, y', 'say "hi"'], ['z', '']], lines: [1, 2, 4] })
  })
  it('tracks the real line of a row after a multi-line quoted field', () => {
    const r = parseCsv('a,b\n"line1\nline2",x\nlast,y')
    expect(r).toMatchObject({ ok: true, lines: [1, 2, 4] })
  })
  it('refuses an unclosed quote and a stray quote', () => {
    expect(parseCsv('a,b\n"open,x')).toMatchObject({ ok: false })
    expect(parseCsv('a,b\nab"c,x')).toMatchObject({ ok: false })
  })
})

describe('calendar import (ADR 0057, S7)', () => {
  it('turns rows into rate cells with integer minor units and no float arithmetic', () => {
    const r = buildCalendarImport(csv(H, 'BB-DBL,2026-11-01,450.50,SELL', 'BB-DBL,2026-11-02,450,net'), lookups())
    expect(r.ok).toBe(true)
    expect(r.rates).toEqual([
      { ratePlanId: 'p1', stayDate: '2026-11-01', occupancy: 2, amountMinor: '45050', amountBasis: 'SELL', currency: 'AED', expectedUpdatedAt: null },
      { ratePlanId: 'p1', stayDate: '2026-11-02', occupancy: 2, amountMinor: '45000', amountBasis: 'NET', currency: 'AED', expectedUpdatedAt: null },
    ])
  })
  it('carries the current cell version so the apply step refuses a stale review', () => {
    const r = buildCalendarImport(csv(H, 'BB-DBL,2026-11-01,450,SELL'), lookups([plan()], { rate: () => ({ updatedAt: '2026-10-01T00:00:00.000Z' }) }))
    expect(r.rates[0]!.expectedUpdatedAt).toBe('2026-10-01T00:00:00.000Z')
  })
  it('builds availability cells, filling what the row omits from the existing cell', () => {
    const existing = { updatedAt: '2026-10-01T00:00:00.000Z', allotment: 7, sold: 1, held: 0, stopSell: false, minStay: 2 }
    const r = buildCalendarImport(csv('plan_code,date,stop_sell', 'BB-DBL,2026-11-01,yes'), lookups([plan()], { availability: () => existing }))
    expect(r.availability).toEqual([{ ratePlanId: 'p1', stayDate: '2026-11-01', allotment: 7, stopSell: true, minStay: 2, expectedUpdatedAt: existing.updatedAt }])
  })
  it('never invents a basis, a currency or a stock figure', () => {
    expect(buildCalendarImport(csv('plan_code,date,amount', 'BB-DBL,2026-11-01,450'), lookups()).fatal[0]).toMatchObject({ code: 'MISSING_COLUMN', field: 'basis' })
    expect(buildCalendarImport(csv(H, 'BB-DBL,2026-11-01,450,'), lookups()).errors[0]).toMatchObject({ code: 'BASIS_INVALID' })
    expect(buildCalendarImport(csv('plan_code,date,stop_sell', 'BB-DBL,2026-11-01,true'), lookups()).errors[0]).toMatchObject({ code: 'ALLOTMENT_REQUIRED' })
    expect(buildCalendarImport(csv('plan_code,date,amount,basis,currency', 'BB-DBL,2026-11-01,450,SELL,USD'), lookups()).errors[0]).toMatchObject({ code: 'CURRENCY_MISMATCH' })
  })
  it('rejects bad amounts with a reason: separators, symbols, zero, too many decimals, exponent forms', () => {
    for (const bad of ['1,200', '$450', '0', '0.00', '450.555', '1e3', '-5', '4 50']) {
      const r = buildCalendarImport(csv(H, `BB-DBL,2026-11-01,"${bad}",SELL`), lookups())
      expect([bad, r.errors[0]?.code]).toEqual([bad, bad === '0' || bad === '0.00' ? 'AMOUNT_NOT_POSITIVE' : 'AMOUNT_INVALID'])
    }
  })
  it('rejects bad dates, dates outside the contract, unknown and ambiguous plans, and a wrong occupancy', () => {
    const two = [plan({ id: 'a', code: 'DUP' }), plan({ id: 'b', code: 'DUP' })]
    const r = buildCalendarImport(csv(H, 'BB-DBL,2026-02-30,450,SELL', 'BB-DBL,2027-01-02,450,SELL', 'NOPE,2026-11-01,450,SELL', 'DUP,2026-11-01,450,SELL'), lookups([plan(), ...two]))
    expect(r.errors.map((e) => e.code)).toEqual(['DATE_INVALID', 'DATE_OUTSIDE_CONTRACT', 'PLAN_NOT_FOUND', 'PLAN_AMBIGUOUS'])
    expect(buildCalendarImport(csv('plan_code,date,occupancy,amount,basis', 'BB-DBL,2026-11-01,3,450,SELL'), lookups()).errors[0]).toMatchObject({ code: 'OCCUPANCY_MISMATCH' })
  })
  it('keeps going after a bad row: good rows are accepted and every bad row is reported with its true line', () => {
    const r = buildCalendarImport(csv(H, 'BB-DBL,2026-11-01,450,SELL', '', 'BB-DBL,bad,450,SELL', 'BB-DBL,2026-11-03,460,SELL'), lookups())
    expect(r.ok).toBe(false)
    expect(r.rates.map((c) => c.stayDate)).toEqual(['2026-11-01', '2026-11-03'])
    expect(r.errors).toEqual([expect.objectContaining({ line: 4, code: 'DATE_INVALID', field: 'date' })])
    expect(r.stats).toMatchObject({ dataRows: 3, acceptedRows: 2, rejectedRows: 1 })
  })
  it('identical duplicates collapse to one cell with a warning; conflicting duplicates reject every occurrence', () => {
    const same = buildCalendarImport(csv(H, 'BB-DBL,2026-11-01,450,SELL', 'BB-DBL,2026-11-01,450.00,SELL'), lookups())
    expect(same.rates).toHaveLength(1)
    expect(same.warnings).toEqual([expect.objectContaining({ line: 3, code: 'DUPLICATE_IDENTICAL' })])
    expect(same.stats.identicalDuplicatesIgnored).toBe(1)
    const conflict = buildCalendarImport(csv(H, 'BB-DBL,2026-11-01,450,SELL', 'BB-DBL,2026-11-01,470,SELL', 'BB-DBL,2026-11-02,450,SELL'), lookups())
    expect(conflict.errors.map((e) => [e.line, e.code])).toEqual([[2, 'DUPLICATE_CONFLICT'], [3, 'DUPLICATE_CONFLICT']])
    expect(conflict.rates.map((c) => c.stayDate)).toEqual(['2026-11-02']) // neither conflicting price was guessed
  })
  it('applies the stock rules per row: below committed rooms, and shared-pool stock', () => {
    const committed = { updatedAt: 'x', allotment: 10, sold: 4, held: 2, stopSell: false, minStay: 1 }
    const low = buildCalendarImport(csv('plan_code,date,allotment', 'BB-DBL,2026-11-01,5'), lookups([plan()], { availability: () => committed }))
    expect(low.errors[0]).toMatchObject({ code: 'ALLOTMENT_BELOW_COMMITTED' })
    const pooled = buildCalendarImport(csv('plan_code,date,allotment,stop_sell', 'BB-DBL,2026-11-01,9,', 'BB-DBL,2026-11-02,10,true'), lookups([plan({ inventoryPoolId: 'pool' })], { availability: () => committed }))
    expect(pooled.errors.map((e) => e.code)).toEqual(['POOLED_STOCK'])
    expect(pooled.availability.map((c) => c.stayDate)).toEqual(['2026-11-02']) // an unchanged allotment with a restriction is fine
  })
  it('refuses the whole file for an unknown column, a missing required column, an oversized file or too many cells', () => {
    expect(buildCalendarImport(csv('plan_code,date,amount,basis,price', 'BB-DBL,2026-11-01,450,SELL,1'), lookups()).fatal[0]).toMatchObject({ code: 'UNKNOWN_COLUMN' })
    expect(buildCalendarImport(csv('date,amount,basis', '2026-11-01,450,SELL'), lookups()).fatal[0]).toMatchObject({ code: 'MISSING_COLUMN' })
    expect(buildCalendarImport(csv('plan_code,date', 'BB-DBL,2026-11-01'), lookups()).fatal[0]).toMatchObject({ code: 'MISSING_COLUMN' })
    expect(buildCalendarImport('', lookups()).fatal[0]).toMatchObject({ code: 'FILE_EMPTY' })
    const dates = Array.from({ length: MAX_IMPORT_CELLS + 1 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10))
    const big = buildCalendarImport(csv(H, ...dates.map((d) => `BB-DBL,${d},450,SELL`)), lookups([plan({ contractValidTo: '2027-12-31' })]))
    expect(big.fatal[0]).toMatchObject({ code: 'TOO_MANY_CELLS' })
    expect(big.rates).toEqual([])
  })
  it('a formula-looking cell is just text and is escaped in the error file', () => {
    const r = buildCalendarImport(csv(H, '=cmd|\' /c calc\'!A1,2026-11-01,450,SELL'), lookups())
    expect(r.errors[0]).toMatchObject({ code: 'PLAN_NOT_FOUND' })
    const out = errorsToCsv([{ line: 9, code: 'X', message: '=SUM(A1)' }, { line: 10, code: 'Y', message: 'has, comma and "quote"' }])
    expect(out).toBe('line,code,field,message\r\n9,X,,\'=SUM(A1)\r\n10,Y,,"has, comma and ""quote"""\r\n')
  })
  it('caps the reported errors but still counts every rejection', () => {
    const rows = Array.from({ length: 300 }, () => 'NOPE,2026-11-01,450,SELL')
    const r = buildCalendarImport(csv(H, ...rows), lookups())
    expect(r.errors).toHaveLength(200)
    expect(r.truncatedErrors).toBe(true)
    expect(r.stats.rejectedRows).toBe(300) // the report is capped, the count is not
  })
})
