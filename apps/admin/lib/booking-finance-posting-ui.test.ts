import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POSTING_REVIEW_REASONS, POSTING_SKIP_REASONS, BOOKING_FINANCE_EVENT_TYPES } from '@bedbanks/contracts'
import { EVENT_TEXT, REVIEW_TEXT, SKIP_TEXT, nextRetryAt, reviewText } from './booking-finance-posting-ui'
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
  const files = ['app/(dashboard)/finance/booking-postings/page.tsx', 'lib/data/booking-finance-postings.ts', 'lib/booking-finance-posting-ui.ts']
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8')
    assert.doesNotMatch(text, /BigInt\(|Number\(.*Minor|parseFloat|\bMath\./, f)
    assert.doesNotMatch(text, /method:\s*'(POST|PUT|PATCH|DELETE)'/, f)
  }
})
