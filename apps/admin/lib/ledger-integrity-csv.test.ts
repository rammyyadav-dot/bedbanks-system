import test from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerIntegrityView } from '@bedbanks/contracts'
import { csvCell, ledgerIntegrityCsv, ledgerIntegrityFilename } from './ledger-integrity-csv'

const view: LedgerIntegrityView = {
  status: 'FAIL', generatedAt: '2026-10-13T02:00:00.000Z', scanned: { accounts: 1, bookings: 1, entries: 3 }, truncated: false,
  counts: { errors: 1, warnings: 0, byCode: [{ code: 'REFUND_EXCEEDS_CHARGE', count: 1 }] },
  findings: [{ code: 'REFUND_EXCEEDS_CHARGE', severity: 'ERROR', message: 'The refund is larger than the amount charged.', bookingId: 'b1', accountId: null, currency: 'AED', amountsMinor: { heldMinor: '1000', releasedMinor: '1000', chargedMinor: '1000', refundedMinor: '1500' } }],
  control: [{ currency: 'AED', accounts: 1, balanceMinor: '-250', creditLineMinor: '0', availableMinor: '-250', overdrawnAccounts: 1, byType: [] }],
  staleAuthorizationHours: 24,
}

test('cells that a spreadsheet would run as a formula are neutralized, and commas and quotes are escaped', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(csvCell('-5'), '-5') // a plain negative integer amount stays a number
  assert.equal(csvCell('-5+2'), "'-5+2")
  assert.equal(csvCell('@x'), "'@x")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell(null), '')
})

test('the CSV carries the verdict, per-currency totals and every finding, with amounts as exact minor-unit integers', () => {
  const lines = ledgerIntegrityCsv(view).trimEnd().split('\r\n')
  assert.equal(lines[1], '2026-10-13T02:00:00.000Z,FAIL,1,0,false')
  assert.ok(lines.includes('AED,1,-250,0,-250,1'))
  assert.ok(lines.includes('ERROR,REFUND_EXCEEDS_CHARGE,b1,,AED,1000,1000,1000,1500,The refund is larger than the amount charged.'))
})

test('the file is named by the report date', () => {
  assert.equal(ledgerIntegrityFilename(view), 'ledger-integrity-2026-10-13.csv')
})
