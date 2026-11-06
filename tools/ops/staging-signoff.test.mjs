import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ACCESS_REVIEW_STALE_LOGIN_DAYS, ACCESS_REVIEW_STATEMENT, ACCESS_REVIEW_SURFACE, STATEMENT, evaluateSignoff } from './staging-signoff.mjs'

const sha = 'a'.repeat(40)
const signature = (role, name = 'Amina Rahman') => ({ role, name, signedAt: '2026-11-04T18:00:00+05:30', statement: STATEMENT })
const accessReview = (reviewer = 'Owner security') => ({
  reviewer, reviewedAt: '2026-11-06T11:30:00+05:30', generatedAt: '2026-11-06T11:28:00+05:30',
  surface: ACCESS_REVIEW_SURFACE, staleLoginDays: ACCESS_REVIEW_STALE_LOGIN_DAYS, statement: ACCESS_REVIEW_STATEMENT,
  counts: { total: 4, holdingSensitive: 1, noRole: 0, inactive: 0, neverLoggedIn: 1, staleLogin: 0 },
  dispositions: { HOLDS_SENSITIVE: 'accepted', NO_ROLE: 'accepted', INACTIVE: 'accepted', NEVER_LOGGED_IN: 'remediated', STALE_LOGIN: 'accepted' },
})
const signed = (extra = {}) => ({ sha, signatures: ['engineering', 'operations', 'security', 'product'].map((role) => signature(role, `Owner ${role}`)), accessReview: accessReview(), ...extra })

test('four distinct roles and a recorded access review on the deployed SHA close the gate', () => {
  assert.deepEqual(evaluateSignoff(signed(), sha), { status: 'SIGNED', problems: [] })
})

test('the stale-login window is the same number the access review service uses', () => {
  const src = readFileSync(new URL('../../apps/api/src/admin-operations/operations-governance.service.ts', import.meta.url), 'utf8')
  assert.match(src, new RegExp(`export const STALE_LOGIN_DAYS = ${ACCESS_REVIEW_STALE_LOGIN_DAYS}\\b`))
})

test('a missing record, a wrong SHA, a repeated role or a placeholder name leaves the gate open', () => {
  assert.equal(evaluateSignoff(null, sha).status, 'OPEN')
  const doc = signed({ sha: 'b'.repeat(40) })
  assert.match(evaluateSignoff(doc, sha).problems.join('\n'), /sha/)
  const named = { sha, signatures: [signature('engineering', 'cursor'), signature('engineering')], accessReview: accessReview('Owner security') }
  assert.match(evaluateSignoff(named, sha).problems.join('\n'), /accountable name|duplicate role|missing/)
})

test('signatures without an access review, or a review that is not the security signer, leave the gate open', () => {
  const bare = signed()
  delete bare.accessReview
  assert.match(evaluateSignoff(bare, sha).problems.join('\n'), /access review missing/)
  const other = signed({ accessReview: accessReview('Someone Else') })
  assert.match(evaluateSignoff(other, sha).problems.join('\n'), /reviewer is not the security signer/)
  const emailed = signed({ accessReview: { ...accessReview(), reviewer: 'Owner security <sec@example.com>' } })
  assert.match(evaluateSignoff(emailed, sha).problems.join('\n'), /email address/)
  const listed = signed({ accessReview: { ...accessReview(), items: [{ email: 'a@b.c' }] } })
  assert.match(evaluateSignoff(listed, sha).problems.join('\n'), /member list|email/)
  const over = signed({ accessReview: { ...accessReview(), counts: { ...accessReview().counts, holdingSensitive: 9 } } })
  assert.match(evaluateSignoff(over, sha).problems.join('\n'), /holdingSensitive exceeds total/)
  const skipped = signed()
  delete skipped.accessReview.dispositions.NO_ROLE
  assert.match(evaluateSignoff(skipped, sha).problems.join('\n'), /no disposition for NO_ROLE/)
  const stale = signed({ accessReview: { ...accessReview(), staleLoginDays: 30 } })
  assert.match(evaluateSignoff(stale, sha).problems.join('\n'), /staleLoginDays/)
})
