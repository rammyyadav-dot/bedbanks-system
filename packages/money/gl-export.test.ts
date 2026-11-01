import test from 'node:test'
import assert from 'node:assert/strict'
import { csvField, journalLinesCsv, journalTotalsCsv, minorToMajorString } from './src/index.ts'

test('minor units become exact decimals using the currency exponent, never a float', () => {
  assert.equal(minorToMajorString(1050n, 'AED'), '10.50')
  assert.equal(minorToMajorString(5n, 'AED'), '0.05')
  assert.equal(minorToMajorString(0n, 'AED'), '0.00')
  assert.equal(minorToMajorString(12345n, 'KWD'), '12.345')
  assert.equal(minorToMajorString(7n, 'KWD'), '0.007')
  assert.equal(minorToMajorString(500n, 'JPY'), '500')
  assert.equal(minorToMajorString(-1050n, 'AED'), '-10.50')
  assert.equal(minorToMajorString(999999999999999999n, 'AED'), '9999999999999999.99')
  assert.throws(() => minorToMajorString(1n, 'XXX'), /Unsupported currency/)
})

test('cells that a spreadsheet could execute are neutralised and special characters are quoted', () => {
  for (const hostile of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) assert.ok(csvField(hostile).replace(/^"/, '').startsWith("'"), hostile)
  assert.equal(csvField('Bank, main'), '"Bank, main"')
  assert.equal(csvField('say "hi"'), '"say ""hi"""')
  assert.equal(csvField('a\nb'), '"a\nb"')
  assert.equal(csvField(null), '')
  assert.equal(csvField(42), '42')
})

const line = (over = {}) => ({ currency: 'AED', category: 'FUNDING_RECEIVED', direction: 'POSITIVE', entries: 2, amountMinor: '10050', debit: '1000', debitName: 'Bank', credit: '2100', creditName: 'Agency account balances', ...over })

test('the lines file has a BOM, CRLF, a header, exact amounts, per-currency line numbers and the mapping version', () => {
  const csv = journalLinesCsv('2026-08', [line(), line({ category: 'BOOKING_CHARGE', amountMinor: '1' }), line({ currency: 'KWD', amountMinor: '12345' })], { FUNDING_RECEIVED: 2, BOOKING_CHARGE: 1 })
  assert.ok(csv.startsWith('﻿month,currency,line,'))
  const rows = csv.slice(1).split('\r\n')
  assert.equal(rows.at(-1), '')
  assert.deepEqual(rows[1].split(','), ['2026-08', 'AED', '1', 'FUNDING_RECEIVED', 'POSITIVE', '2', '1000', 'Bank', '2100', 'Agency account balances', '100.50', '10050', '2'])
  assert.deepEqual([rows[2].split(',')[2], rows[2].split(',')[10], rows[3].split(',')[2], rows[3].split(',')[10]], ['2', '0.01', '1', '12.345'])
})

test('an account name that looks like a formula cannot execute', () => {
  const csv = journalLinesCsv('2026-08', [line({ debitName: '=HYPERLINK("http://x")' })], {})
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`))
})

test('the totals file lists debit and credit per currency and account in major and minor units', () => {
  const csv = journalTotalsCsv('2026-08', [{ currency: 'AED', accountCode: '2100', accountName: 'Agency account balances', debitMinor: '250', creditMinor: '10050' }])
  assert.deepEqual(csv.slice(1).split('\r\n')[1].split(','), ['2026-08', 'AED', '2100', 'Agency account balances', '2.50', '100.50', '250', '10050'])
})

test('an empty journal is a header only', () => assert.equal(journalLinesCsv('2026-08', [], {}).slice(1).split('\r\n').length, 2))
