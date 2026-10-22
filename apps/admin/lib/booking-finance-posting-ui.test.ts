import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POSTING_REVIEW_REASONS, POSTING_SKIP_REASONS, BOOKING_FINANCE_EVENT_TYPES } from '@bedbanks/contracts'
import { EVENT_TEXT, REVIEW_TEXT, SKIP_TEXT, nextRetryAt, reviewText, termsText } from './booking-finance-posting-ui'
import { flatNav } from '../components/layout/nav-config'

const root = join(import.meta.dirname, '..')

test('every reason and event type has operator-facing text, so the page can never show a raw code as its only explanation', () => {
  for (const r of POSTING_REVIEW_REASONS) { assert.ok(REVIEW_TEXT[r].title, r); assert.ok(REVIEW_TEXT[r].action, r) }
  for (const r of POSTING_SKIP_REASONS) assert.ok(SKIP_TEXT[r], r)
  for (const t of BOOKING_FINANCE_EVENT_TYPES) assert.ok(EVENT_TEXT[t], t)
  assert.match(reviewText('SOMETHING_NEW').action, /engineer/)
})

test('the next retry is five minutes after the last attempt', () => {
  assert.equal(nextRetryAt('2026-10-21T10:00:00.000Z'), '2026-10-21T10:05:00.000Z')
})

test('the booking postings page is a real, permission-gated, read-only module with no money arithmetic', () => {
  const item = flatNav.find((n) => n.href === '/finance/booking-postings')
  assert.ok(item, 'listed in navigation')
  assert.equal(item.requires, 'finance.read')
  const revenue = flatNav.find((n) => n.href === '/finance/booking-revenue')
  assert.ok(revenue, 'revenue report listed in navigation')
  assert.equal(revenue.requires, 'finance.read')
  const files = ['app/(dashboard)/finance/booking-postings/page.tsx', 'app/(dashboard)/finance/booking-revenue/page.tsx', 'lib/data/booking-finance-postings.ts', 'lib/booking-finance-posting-ui.ts']
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8')
    assert.doesNotMatch(text, /BigInt\(|Number\(.*Minor|parseFloat|\bMath\./, f)
    // The data file also holds the settlement writes (ADR 0077); the postings, revenue and payables pages themselves never write.
    if (f.endsWith('page.tsx')) assert.doesNotMatch(text, /method:\s*'(POST|PUT|PATCH|DELETE)'|proposeSettlement|approveSettlement|rejectSettlement/, f)
  }
})

test('the revenue page adds nothing up in the browser: it shows API figures, and never sums across currencies', () => {
  const text = readFileSync(join(root, 'app/(dashboard)/finance/booking-revenue/page.tsx'), 'utf8')
  assert.doesNotMatch(text, /\.reduce\(|BigInt|Number\(|parseInt|\+ Number/)
  assert.match(text, /currencies\.map/)
})

test('the payables page shows the consumer\'s posted payables as a separate, labelled basis, with its own failure state, and adds nothing up', () => {
  const text = readFileSync(join(root, 'app/(dashboard)/finance/payables/page.tsx'), 'utf8')
  assert.match(text, /getPostedPayables/)
  assert.match(text, /different basis/)
  assert.match(text, /Neither is an amount to pay/)
  assert.match(text, /Outstanding/)
  assert.doesNotMatch(text, /\.reduce\(|BigInt|Number\(/)
})

test('the aging section says what its age means, has its own failure state, and adds nothing up', () => {
  const text = readFileSync(join(root, 'app/(dashboard)/finance/payables/page.tsx'), 'utf8')
  assert.match(text, /getPayablesAging/)
  assert.match(text, /not how late it is/)
  assert.match(text, /oldest bookings first/)
  assert.match(text, /PAYABLE_AGING_BUCKETS/)
  assert.doesNotMatch(text, /\.reduce\(|BigInt|Number\(/)
})

test('the settlements page is permission-gated, converts amounts with the shared BigInt helper only, and never decides who may approve', () => {
  const item = flatNav.find((n) => n.href === '/finance/supplier-settlements')
  assert.ok(item, 'listed in navigation'); assert.equal(item.requires, 'finance.read')
  const text = readFileSync(join(root, 'app/(dashboard)/finance/supplier-settlements/page.tsx'), 'utf8')
  assert.match(text, /parseMajorToMinor/)
  assert.match(text, /can\('finance\.settle\.propose'\)/)
  assert.match(text, /can\('finance\.settle\.approve'\)/)
  assert.doesNotMatch(text, /parseFloat|Number\(|\.reduce\(|Math\./)
  assert.doesNotMatch(text, /proposedById\s*[!=]==?\s*/, 'the server, not the page, refuses a self-approval')
})

test('payment terms text reads naturally and never invents terms', () => {
  assert.equal(termsText(null, null), 'No terms set')
  assert.equal(termsText('CHECK_OUT', 30), '30 days after check-out')
  assert.equal(termsText('CONFIRMATION', 1), '1 day after confirmation')
})

test('the due section says no terms or no date is never overdue, links terms to the settlements page, and adds nothing up', () => {
  const text = readFileSync(join(root, 'app/(dashboard)/finance/payables/page.tsx'), 'utf8')
  assert.match(text, /getPayablesDue/)
  assert.match(text, /never shown as overdue/)
  assert.match(text, /earliest-due bookings first/)
  assert.match(text, /PAYABLE_DUE_BUCKETS/)
  assert.doesNotMatch(text, /\.reduce\(|BigInt|Number\(/)
  const page = readFileSync(join(root, 'app/(dashboard)/finance/supplier-settlements/page.tsx'), 'utf8')
  assert.match(page, /can\('finance\.terms\.manage'\)/)
  assert.match(page, /kept as history/)
})
