import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPaste, buildGridEdit, issuesToCsv, parsePaste, type GridDraft } from './calendar-tools'

const plans = [{ id: 'p1', code: 'A', currency: 'AED', occupancy: 2 }, { id: 'p2', code: 'B', currency: 'AED', occupancy: 2 }]
const dates = ['2026-11-01', '2026-11-02', '2026-11-03']
const draft = (over: Partial<GridDraft> = {}): GridDraft => ({ plans, dates, baseline: { p1: { '2026-11-01': { amount: '450.00', updatedAt: '2026-10-01T00:00:00.000Z' } } }, edited: {}, basis: { p1: 'SELL', p2: 'SELL' }, ...over })

test('paste parses tabs and any newline style, and ignores one trailing newline', () => {
  assert.deepEqual(parsePaste('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']])
  assert.deepEqual(parsePaste(' 450 '), [['450']])
})
test('paste fills right and down, clipped to the grid, keeping other edits', () => {
  const next = applyPaste({ plans, dates, edited: { p2: { '2026-11-03': '9' } } }, 0, 1, [['10', '11', '12'], ['20']])
  assert.deepEqual(next, { p1: { '2026-11-02': '10', '2026-11-03': '11' }, p2: { '2026-11-02': '20', '2026-11-03': '9' } })
})
test('only changed cells become rate cells, in integer minor units with the cell version', () => {
  const r = buildGridEdit(draft({ edited: { p1: { '2026-11-01': '455.5', '2026-11-02': '460' }, p2: { '2026-11-01': '' } } }))
  assert.equal(r.changed, 2)
  assert.deepEqual(r.edit?.rates?.map((c) => [c.ratePlanId, c.stayDate, c.amountMinor, c.amountBasis, c.expectedUpdatedAt]), [
    ['p1', '2026-11-01', '45550', 'SELL', '2026-10-01T00:00:00.000Z'],
    ['p1', '2026-11-02', '46000', 'SELL', null],
  ])
  assert.deepEqual(r.problems, [])
})
test('an unchanged value, even typed differently in spacing, is not a change', () => {
  assert.equal(buildGridEdit(draft({ edited: { p1: { '2026-11-01': ' 450.00 ' } } })).edit, null)
})
test('a plan with no chosen basis blocks its cells: the basis is never assumed', () => {
  const r = buildGridEdit(draft({ basis: { p1: '', p2: 'SELL' }, edited: { p1: { '2026-11-02': '460' }, p2: { '2026-11-02': '470' } } }))
  assert.equal(r.edit?.rates?.length, 1)
  assert.equal(r.edit?.rates?.[0]?.ratePlanId, 'p2')
  assert.match(r.problems[0]!.message, /Choose NET or SELL/)
})
test('bad amounts and cleared prices are reported, never repaired', () => {
  const r = buildGridEdit(draft({ edited: { p1: { '2026-11-01': '', '2026-11-02': '1,200', '2026-11-03': '0' } } }))
  assert.equal(r.edit, null)
  assert.equal(r.problems.length, 3)
  assert.match(r.problems.find((p) => p.date === '2026-11-01')!.message, /cannot be cleared/)
  assert.match(r.problems.find((p) => p.date === '2026-11-02')!.message, /not a valid AED price/)
})
test('too many changed cells is refused with a count rather than truncated', () => {
  const many = Array.from({ length: 367 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10))
  const edited = { p1: Object.fromEntries(many.map((d) => [d, '100'])) }
  const r = buildGridEdit({ plans, dates: many, baseline: {}, edited, basis: { p1: 'SELL', p2: 'SELL' } })
  assert.equal(r.edit, null)
  assert.match(r.problems[r.problems.length - 1]!.message, /367 changed cells/)
})
test('the error file is escaped against spreadsheet formulas and quotes', () => {
  assert.equal(issuesToCsv([{ line: 3, code: 'X', message: '=HYPERLINK("http://x")', field: 'amount' }]), 'line,code,field,message\r\n3,X,amount,"\'=HYPERLINK(""http://x"")"\r\n')
})
