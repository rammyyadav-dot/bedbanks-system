import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLedgerIntegrity, type IntegrityAdjustment, type IntegrityBooking, type IntegrityEntry, type IntegrityInput, type IntegrityReceipt } from './src/index.ts'

const NOW = new Date('2026-10-17T12:00:00Z')
const T0 = new Date('2026-10-17T11:55:00Z')
const OLD = new Date('2026-10-17T09:00:00Z')
let seq = 0
const e = (type: IntegrityEntry['type'], amountMinor: bigint, key: string, reference: string | null, extra: Partial<IntegrityEntry> = {}): IntegrityEntry =>
  ({ id: `e${++seq}`, accountId: 'acc', type, amountMinor, currency: 'AED', reference, idempotencyKey: key, at: T0, ...extra })
const hold = (b: string, x: bigint, at = T0) => e('HOLD', -x, `booking:${b}:authorize`, `booking:${b}`, { at })
const release = (b: string, x: bigint) => e('RELEASE', x, `booking:${b}:authorize:release`, `booking:${b}`)
const settle = (b: string, x: bigint) => [e('RELEASE', x, `booking:${b}:authorize:settle-release`, `booking:${b}`), e('DEBIT', -x, `booking:${b}:authorize:settle-debit`, `booking:${b}`)]
const refund = (b: string, x: bigint) => e('REFUND', x, `booking:${b}:cancel-refund`, `booking:${b}`)
const booking = (id: string, status: string, totalMinor: bigint, extra: Partial<IntegrityBooking> = {}): IntegrityBooking => ({ id, status, currency: 'AED', totalMinor, ...extra })
const run = (over: Partial<IntegrityInput>) => checkLedgerIntegrity({
  accounts: [{ id: 'acc', currency: 'AED', agencyId: 'ag', creditLineMinor: 1_000_000n }], entries: [], bookings: [], receipts: [], now: NOW, staleReservationMinutes: 30, ...over,
})
const codes = (over: Partial<IntegrityInput>) => run(over).findings.map(f => f.code)

test('a funded, booked, confirmed and partly refunded account is clean and rolls forward per currency', () => {
  const credit = e('CREDIT', 100_000n, 'funding:r1', 'funding:r1')
  const receipts: IntegrityReceipt[] = [{ id: 'r1', status: 'POSTED', accountId: 'acc', ledgerEntryId: credit.id, amountMinor: 100_000n, currency: 'AED' }]
  const entries = [credit, hold('b1', 40_000n), ...settle('b1', 40_000n), refund('b1', 30_000n), hold('b2', 5_000n), release('b2', 5_000n), hold('b3', 7_000n)]
  const report = run({ entries, receipts, bookings: [booking('b1', 'CANCELLED', 40_000n, { cancellationRefundMinor: 30_000n }), booking('b2', 'FAILED', 5_000n), booking('b3', 'PENDING_SUPPLIER', 7_000n)] })
  assert.deepEqual(report.findings, [])
  const [aed] = report.totals
  assert.equal(aed.balanceMinor, 100_000n - 40_000n + 30_000n - 7_000n)
  assert.equal(aed.balanceMinor, aed.fundingCreditsMinor + aed.otherCreditsMinor + aed.refundsMinor - aed.chargesMinor - aed.openReservationsMinor)
  assert.equal(aed.openReservationsMinor, 7_000n)
  assert.equal(aed.postedReceiptsMinor, aed.fundingCreditsMinor)
  assert.equal(report.bookingsChecked, 3)
})

test('entry rules: sign, zero, currency and unknown account', () => {
  assert.deepEqual(codes({ entries: [e('CREDIT', -1n, 'k1', null)] }), ['ENTRY_SIGN_INVALID'])
  assert.deepEqual(codes({ entries: [e('DEBIT', 0n, 'k2', null)] }), ['ENTRY_SIGN_INVALID'])
  assert.deepEqual(codes({ entries: [e('CREDIT', 5n, 'k3', null, { currency: 'USD' })] }), ['ENTRY_CURRENCY_MISMATCH'])
  assert.deepEqual(codes({ entries: [e('CREDIT', 5n, 'k4', null, { accountId: 'other' })] }), ['ENTRY_ACCOUNT_UNKNOWN'])
})

test('over credit line is a warning with the amounts that show it, never mixed across currencies', () => {
  const report = run({ accounts: [{ id: 'acc', currency: 'AED', agencyId: 'ag', creditLineMinor: 1_000n }], entries: [hold('b1', 1_500n)], bookings: [booking('b1', 'PENDING_SUPPLIER', 1_500n)] })
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].code, 'ACCOUNT_OVER_CREDIT_LINE')
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.findings[0].amounts.overByMinor, 500n)
  assert.deepEqual(codes({ accounts: [{ id: 'acc', currency: 'AED', agencyId: 'ag', creditLineMinor: 1_500n }], entries: [hold('b1', 1_500n)], bookings: [booking('b1', 'PENDING_SUPPLIER', 1_500n)] }), [])
})

test('a reservation released and then also settled is caught: the agency would hold a confirmed stay at no net cost', () => {
  const found = codes({ entries: [hold('b1', 1_000n), release('b1', 1_000n), ...settle('b1', 1_000n)], bookings: [booking('b1', 'CONFIRMED', 1_000n)] })
  assert.ok(found.includes('RESERVATION_OVER_RELEASED'))
})

test('settlement must be a balanced RELEASE + DEBIT pair backed by a reservation', () => {
  const [settleRelease] = settle('b1', 1_000n)
  assert.ok(codes({ entries: [hold('b1', 1_000n), settleRelease], bookings: [booking('b1', 'CONFIRMED', 1_000n)] }).includes('SETTLEMENT_UNBALANCED'))
  const [, debit] = settle('b2', 1_000n)
  assert.ok(codes({ entries: [debit], bookings: [booking('b2', 'CONFIRMED', 1_000n)] }).includes('CHARGE_WITHOUT_RESERVATION'))
})

test('a refund can never exceed the charge', () => {
  assert.ok(codes({ entries: [hold('b1', 1_000n), ...settle('b1', 1_000n), refund('b1', 1_001n)], bookings: [booking('b1', 'CANCELLED', 1_000n, { cancellationRefundMinor: 1_001n })] }).includes('REFUND_EXCEEDS_CHARGE'))
})

test('a reservation older than the threshold with no outcome is stale; inside it is not', () => {
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n, OLD)], bookings: [booking('b1', 'PENDING_SUPPLIER', 1_000n)] }), ['RESERVATION_STALE'])
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n)], bookings: [booking('b1', 'PENDING_SUPPLIER', 1_000n)] }), [])
})

test('ledger ties out to the booking: missing booking, wrong amount, confirmed unpaid, charged unconfirmed, money stuck on a failed booking', () => {
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n)] }), ['BOOKING_NOT_FOUND'])
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n), ...settle('b1', 1_000n)], bookings: [booking('b1', 'CONFIRMED', 1_200n)] }), ['CHARGE_AMOUNT_MISMATCH'])
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n)], bookings: [booking('b1', 'CONFIRMED', 1_000n)] }), ['CONFIRMED_NOT_CHARGED'])
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n), ...settle('b1', 1_000n)], bookings: [booking('b1', 'FAILED', 1_000n)] }), ['CHARGED_NOT_CONFIRMED'])
  assert.deepEqual(codes({ entries: [hold('b1', 1_000n)], bookings: [booking('b1', 'FAILED', 1_000n)] }), ['RESERVATION_ON_CLOSED_BOOKING'])
})

test('a cancelled booking must carry exactly the refund its cancellation record fixed', () => {
  const charged = [hold('b1', 1_000n), ...settle('b1', 1_000n)]
  // Cancelled outside the ledger path (no cancellation record): the charge stays on the agency.
  assert.deepEqual(codes({ entries: charged, bookings: [booking('b1', 'CANCELLED', 1_000n)] }), ['CANCELLED_REFUND_NOT_POSTED'])
  assert.deepEqual(codes({ entries: [...charged, refund('b1', 400n)], bookings: [booking('b1', 'CANCELLED', 1_000n, { cancellationRefundMinor: 600n })] }), ['REFUND_MISMATCH'])
  // A full penalty is a cancellation record with a zero refund and no REFUND entry: clean.
  assert.deepEqual(codes({ entries: charged, bookings: [booking('b1', 'CANCELLED', 1_000n, { cancellationRefundMinor: 0n })] }), [])
})

test('funding receipts and funding credits tie out both ways', () => {
  const credit = e('CREDIT', 500n, 'funding:r1', 'funding:r1')
  assert.deepEqual(codes({ entries: [credit] }), ['CREDIT_WITHOUT_RECEIPT'])
  assert.deepEqual(codes({ entries: [credit], receipts: [{ id: 'r1', status: 'POSTED', accountId: 'acc', ledgerEntryId: credit.id, amountMinor: 600n, currency: 'AED' }] }), ['RECEIPT_NOT_IN_LEDGER'])
  assert.deepEqual(codes({ receipts: [{ id: 'r2', status: 'POSTED', accountId: 'acc', ledgerEntryId: 'missing', amountMinor: 600n, currency: 'AED' }] }), ['RECEIPT_NOT_IN_LEDGER'])
  assert.deepEqual(codes({ receipts: [{ id: 'r3', status: 'VERIFIED', accountId: null, ledgerEntryId: null, amountMinor: 600n, currency: 'AED' }] }), [])
})

test('critical findings sort before warnings', () => {
  const report = run({ accounts: [{ id: 'acc', currency: 'AED', agencyId: 'ag', creditLineMinor: 0n }], entries: [hold('b1', 1_000n, OLD), e('CREDIT', -1n, 'x', null)], bookings: [booking('b1', 'PENDING_SUPPLIER', 1_000n)] })
  assert.deepEqual(report.findings.map(f => f.severity), ['critical', 'warning', 'warning'])
})

test('hash chain faults from the database verifier become critical findings and make the report not clean (ADR 0094)', async () => {
  const { checkLedgerIntegrity } = await import('./src/ledger-integrity.ts')
  const input = { accounts: [{ id: 'w1', currency: 'AED', agencyId: null, creditLineMinor: 0n }], entries: [], bookings: [], receipts: [], now: new Date('2026-10-26T00:00:00Z'), staleReservationMinutes: 60 }
  assert.deepEqual(checkLedgerIntegrity(input).findings, [])
  assert.deepEqual(checkLedgerIntegrity({ ...input, chainBreaks: [] }).findings, [])
  const r = checkLedgerIntegrity({ ...input, chainBreaks: [
    { accountId: 'w1', entryId: 'e1', seq: 2, reason: 'ENTRY_HASH_MISMATCH' },
    { accountId: 'w1', entryId: 'e9', seq: null, reason: 'ENTRY_UNCHAINED' },
    { accountId: 'w1', entryId: 'e3', seq: 4, reason: 'SEQUENCE_GAP' },
  ] })
  assert.deepEqual(r.findings.map((f) => [f.code, f.severity, f.entryId, f.currency, f.amounts]), [
    ['LEDGER_CHAIN_BROKEN', 'critical', 'e1', 'AED', { seq: 2n }],
    ['LEDGER_CHAIN_BROKEN', 'critical', 'e3', 'AED', { seq: 4n }],
    ['LEDGER_CHAIN_ENTRY_UNCHAINED', 'critical', 'e9', 'AED', {}],
  ])
})

const adj = (id: string, kind: 'ADJUSTMENT' | 'REVERSAL', entry: IntegrityEntry, extra: Partial<IntegrityAdjustment> = {}): IntegrityAdjustment =>
  ({ id, kind, status: 'APPROVED', accountId: 'acc', ledgerEntryId: entry.id, amountMinor: entry.amountMinor, currency: 'AED', receiptId: null, ...extra })

test('adjustments and reversals roll forward and are clean when each entry is an approved record', () => {
  const credit = e('CREDIT', 100_000n, 'funding:r1', 'funding:r1')
  const receipts: IntegrityReceipt[] = [{ id: 'r1', status: 'POSTED', accountId: 'acc', ledgerEntryId: credit.id, amountMinor: 100_000n, currency: 'AED' }]
  const fee = e('ADJUSTMENT', -2_500n, 'adjustment:a1', 'adjustment:a1')
  const bonus = e('ADJUSTMENT', 1_000n, 'adjustment:a2', 'adjustment:a2')
  const recall = e('REVERSAL', -30_000n, 'funding:r1:reversal:a3', 'funding:r1')
  const report = run({ entries: [credit, fee, bonus, recall], receipts, adjustments: [adj('a1', 'ADJUSTMENT', fee), adj('a2', 'ADJUSTMENT', bonus), adj('a3', 'REVERSAL', recall, { receiptId: 'r1' })] })
  assert.deepEqual(report.findings, [])
  const [aed] = report.totals
  assert.equal(aed.adjustmentsMinor, -1_500n)
  assert.equal(aed.reversalsMinor, 30_000n)
  assert.equal(aed.balanceMinor, 100_000n - 1_500n - 30_000n)
  assert.equal(aed.balanceMinor, aed.fundingCreditsMinor + aed.otherCreditsMinor + aed.refundsMinor - aed.chargesMinor - aed.openReservationsMinor + aed.adjustmentsMinor - aed.reversalsMinor)
})

test('an adjustment or reversal entry with no approved record, or one that differs from its record, is critical', () => {
  const fee = e('ADJUSTMENT', -2_500n, 'adjustment:a1', 'adjustment:a1')
  const recall = e('REVERSAL', -300n, 'funding:r1:reversal:a2', 'funding:r1')
  const credit = e('CREDIT', 1_000n, 'funding:r1', 'funding:r1')
  const receipts: IntegrityReceipt[] = [{ id: 'r1', status: 'POSTED', accountId: 'acc', ledgerEntryId: credit.id, amountMinor: 1_000n, currency: 'AED' }]
  assert.deepEqual(codes({ entries: [fee], adjustments: [] }), ['ADJUSTMENT_WITHOUT_APPROVAL'])
  assert.deepEqual(codes({ entries: [fee], adjustments: [adj('a1', 'ADJUSTMENT', fee, { status: 'PROPOSED' })] }), ['ADJUSTMENT_WITHOUT_APPROVAL'])
  assert.deepEqual(codes({ entries: [fee], adjustments: [adj('a1', 'ADJUSTMENT', fee, { amountMinor: -2_000n })] }), ['ADJUSTMENT_WITHOUT_APPROVAL'])
  assert.deepEqual(codes({ entries: [credit, recall], receipts, adjustments: [adj('a2', 'ADJUSTMENT', recall, { kind: 'ADJUSTMENT' })] }), ['ADJUSTMENT_WITHOUT_APPROVAL'])
  // The rule is off when the register was not loaded.
  assert.deepEqual(codes({ entries: [fee] }), [])
})

test('reversals above what the receipt paid, or of a receipt that was never posted, are critical', () => {
  const credit = e('CREDIT', 1_000n, 'funding:r1', 'funding:r1')
  const r1 = e('REVERSAL', -700n, 'funding:r1:reversal:a1', 'funding:r1')
  const r2 = e('REVERSAL', -400n, 'funding:r1:reversal:a2', 'funding:r1')
  const receipts: IntegrityReceipt[] = [{ id: 'r1', status: 'POSTED', accountId: 'acc', ledgerEntryId: credit.id, amountMinor: 1_000n, currency: 'AED' }]
  const adjustments = [adj('a1', 'REVERSAL', r1, { receiptId: 'r1' }), adj('a2', 'REVERSAL', r2, { receiptId: 'r1' })]
  const report = run({ entries: [credit, r1, r2], receipts, adjustments })
  assert.deepEqual(report.findings.map(f => f.code), ['REVERSAL_EXCEEDS_RECEIPT'])
  assert.equal(report.findings[0].amounts.reversedMinor, 1_100n)
  assert.equal(report.findings[0].receiptId, 'r1')
  assert.deepEqual(codes({ entries: [credit, r1], receipts: [{ ...receipts[0], status: 'REJECTED' }], adjustments: [adjustments[0]] }).includes('REVERSAL_EXCEEDS_RECEIPT'), true)
})
