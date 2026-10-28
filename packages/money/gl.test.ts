import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GL_ACCOUNTS, DEFAULT_GL_MAPPINGS, GL_CATEGORIES, GlFold, buildJournal, classifyEntry, mappingProblem, type GlAccountRef, type GlLedgerEntry, type GlMapping } from './src/index.ts'

const e = (type: string, amountMinor: bigint, reference: string | null, idempotencyKey: string, currency = 'AED'): GlLedgerEntry => ({ type, amountMinor, currency, reference, idempotencyKey })
const accounts = new Map<string, GlAccountRef>(DEFAULT_GL_ACCOUNTS.map(a => [a.code, a]))
const mapping = Object.fromEntries(DEFAULT_GL_MAPPINGS.map(m => [m.category, { debit: accounts.get(m.debit)!, credit: accounts.get(m.credit)! }])) as GlMapping

test('the default chart has unique codes and maps every category to two different known accounts', () => {
  assert.equal(new Set(DEFAULT_GL_ACCOUNTS.map(a => a.code)).size, DEFAULT_GL_ACCOUNTS.length)
  assert.deepEqual([...DEFAULT_GL_MAPPINGS.map(m => m.category)].sort(), [...GL_CATEGORIES].sort())
  for (const m of DEFAULT_GL_MAPPINGS) { assert.ok(accounts.has(m.debit) && accounts.has(m.credit)); assert.notEqual(m.debit, m.credit) }
})

test('classification follows what the posting code writes', () => {
  assert.equal(classifyEntry(e('CREDIT', 5n, 'funding:r1', 'funding:r1')), 'FUNDING_RECEIVED')
  assert.equal(classifyEntry(e('CREDIT', 5n, 'agency:a1', 'agency:a1:commission-payout:p1')), 'COMMISSION_PAYOUT')
  assert.equal(classifyEntry(e('CREDIT', 5n, null, 'manual')), 'OTHER_CREDIT')
  assert.equal(classifyEntry(e('REVERSAL', -5n, 'funding:r1', 'funding:r1:reversal:x')), 'PAYMENT_REVERSAL')
  assert.equal(classifyEntry(e('HOLD', -5n, 'booking:b', 'booking:b:authorize')), 'RESERVATION')
  assert.equal(classifyEntry(e('RELEASE', 5n, 'booking:b', 'booking:b:authorize:settle-release')), 'RESERVATION')
  assert.equal(classifyEntry(e('DEBIT', -5n, 'booking:b', 'booking:b:authorize:settle-debit')), 'BOOKING_CHARGE')
  assert.equal(classifyEntry(e('REFUND', 5n, 'booking:b', 'booking:b:cancel-refund')), 'BOOKING_REFUND')
  assert.equal(classifyEntry(e('REFUND', 5n, 'booking:b', 'booking:b:credit-note:n1')), 'CREDIT_NOTE')
  assert.equal(classifyEntry(e('ADJUSTMENT', -5n, 'adjustment:a', 'adjustment:a')), 'ADJUSTMENT')
  assert.equal(classifyEntry(e('MYSTERY', 5n, null, 'k')), null)
})

test('a booking lifecycle journals gross, balances per currency, and leaves the agency account at the ledger balance', () => {
  const fold = new GlFold()
  for (const x of [
    e('CREDIT', 100_000n, 'funding:r1', 'funding:r1'),
    e('HOLD', -40_000n, 'booking:b', 'booking:b:authorize'), e('RELEASE', 40_000n, 'booking:b', 'booking:b:authorize:settle-release'), e('DEBIT', -40_000n, 'booking:b', 'booking:b:authorize:settle-debit'),
    e('REFUND', 30_000n, 'booking:b', 'booking:b:cancel-refund'), e('REVERSAL', -10_000n, 'funding:r1', 'funding:r1:reversal:x'), e('ADJUSTMENT', -2_500n, 'adjustment:a', 'adjustment:a'),
    e('CREDIT', 70n, 'funding:r2', 'funding:r2', 'USD'),
  ]) fold.add(x)
  const j = buildJournal(fold.result(), mapping)
  assert.equal(j.balanced, true)
  const aed = j.accountTotals.filter(t => t.currency === 'AED')
  const acct = (code: string) => aed.find(t => t.account.code === code)!
  // 2100 credits: funding 100000 + release 40000 + refund 30000 ; debits: hold 40000 + charge 40000 + reversal 10000 + adjustment 2500
  assert.deepEqual([acct('2100').debitMinor, acct('2100').creditMinor], [92_500n, 170_000n])
  // The liability account net equals the signed ledger sum (credit balance positive).
  assert.equal(acct('2100').creditMinor - acct('2100').debitMinor, fold.netByCurrency.get('AED'))
  assert.equal(j.accountTotals.find(t => t.currency === 'USD' && t.account.code === '2100')!.creditMinor, 70n)
  assert.deepEqual(j.lines.filter(l => l.category === 'RESERVATION').map(l => [l.direction, l.amountMinor]), [['NEGATIVE', 40_000n], ['POSITIVE', 40_000n]])
})

test('an unmappable entry is counted, never silently dropped into an account', () => {
  const fold = new GlFold()
  fold.add(e('MYSTERY', 5n, null, 'k')); fold.add(e('CREDIT', 9n, 'funding:r', 'funding:r'))
  assert.equal(fold.unmapped, 1)
  assert.equal(fold.entries, 2)
  assert.equal(buildJournal(fold.result(), mapping).lines.length, 1)
})

test('an empty period is an empty, balanced journal', () => assert.deepEqual(buildJournal([], mapping), { lines: [], accountTotals: [], balanced: true }))

test('a mapping needs two different existing accounts', () => {
  const a = accounts.get('1000')!, b = accounts.get('2100')!
  assert.equal(mappingProblem(a, b), null)
  assert.match(mappingProblem(a, a)!, /differ/)
  assert.match(mappingProblem(undefined, b)!, /exist/)
})
