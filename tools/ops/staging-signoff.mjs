// Exit gate for staging acceptance (ADR 0112, amendment 1). Fails closed: four roles, one deployed SHA,
// the exact statement, and a security-owner access-assignment review. This file does not grant a signature.
// A missing record leaves the gate open.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROLES = ['engineering', 'operations', 'security', 'product']
export const STATEMENT = 'I accept the staging evidence for this SHA.'
export const ACCESS_FLAGS = ['HOLDS_SENSITIVE', 'NO_ROLE', 'INACTIVE', 'NEVER_LOGGED_IN', 'STALE_LOGIN']
export const ACCESS_COUNT_KEYS = ['total', 'holdingSensitive', 'noRole', 'inactive', 'neverLoggedIn', 'staleLogin']
export const ACCESS_REVIEW_STATEMENT = 'I reviewed tenant access assignments for this SHA on the staging Access reviews page and recorded a disposition for every flag.'
export const ACCESS_REVIEW_SURFACE = 'admin:/access-review'
/** Must stay equal to STALE_LOGIN_DAYS in operations-governance.service.ts. */
export const ACCESS_REVIEW_STALE_LOGIN_DAYS = 90
const DISPOSITIONS = new Set(['accepted', 'remediated'])
const DENY = /^(cursor|agent|cloud agent|unknown|n\/a|na|tbd|todo)$/i
const BANNED_REVIEW_KEYS = new Set(['userId', 'email', 'sensitivePermissions', 'password', 'passwordHash', 'members', 'items'])

function accountableName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return name.length >= 2 && !DENY.test(name) ? name : ''
}

/** Aggregate counts and one disposition per flag. No member list, no email. */
export function accessReviewProblems(review, securityName) {
  const problems = []
  if (!review || typeof review !== 'object' || Array.isArray(review)) return ['access review missing']
  const walk = (value) => {
    if (Array.isArray(value)) {
      problems.push('access review must be counts and dispositions, not a member list')
      return
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && value.includes('@')) problems.push('access review must not contain an email address')
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (BANNED_REVIEW_KEYS.has(key)) problems.push(`access review must not include ${key}`)
      walk(child)
    }
  }
  walk(review)
  if (review.surface !== ACCESS_REVIEW_SURFACE) problems.push('access review surface is not the staging Access reviews page')
  if (review.statement !== ACCESS_REVIEW_STATEMENT) problems.push('access review statement does not match')
  if (review.staleLoginDays !== ACCESS_REVIEW_STALE_LOGIN_DAYS) problems.push('access review staleLoginDays does not match the product rule')
  if (Number.isNaN(Date.parse(review.reviewedAt))) problems.push('access review has no reviewedAt')
  if (Number.isNaN(Date.parse(review.generatedAt))) problems.push('access review has no generatedAt')
  const reviewer = accountableName(review.reviewer)
  if (!reviewer) problems.push('access review has no accountable reviewer')
  else if (reviewer !== securityName) problems.push('access review reviewer is not the security signer')
  const counts = review.counts
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) problems.push('access review counts missing')
  else {
    for (const key of ACCESS_COUNT_KEYS) {
      if (!Number.isInteger(counts[key]) || counts[key] < 0) problems.push(`access review count ${key} is not a non-negative integer`)
    }
    if (Number.isInteger(counts.total)) {
      for (const key of ACCESS_COUNT_KEYS) {
        if (key !== 'total' && Number.isInteger(counts[key]) && counts[key] > counts.total) problems.push(`access review count ${key} exceeds total`)
      }
    }
  }
  const dispositions = review.dispositions
  if (!dispositions || typeof dispositions !== 'object' || Array.isArray(dispositions)) problems.push('access review dispositions missing')
  else {
    for (const flag of ACCESS_FLAGS) {
      if (!DISPOSITIONS.has(dispositions[flag])) problems.push(`access review has no disposition for ${flag}`)
    }
  }
  return problems
}

export function evaluateSignoff(doc, expectedSha) {
  const problems = []
  if (!doc || typeof doc !== 'object') return { status: 'OPEN', problems: ['sign-off record missing'] }
  if (doc.sha !== expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha ?? '')) problems.push('sha does not match the deployed commit')
  const signatures = Array.isArray(doc.signatures) ? doc.signatures : []
  const seen = new Set()
  for (const signature of signatures) {
    if (!ROLES.includes(signature.role)) problems.push(`unknown role ${signature.role}`)
    else if (seen.has(signature.role)) problems.push(`duplicate role ${signature.role}`)
    else seen.add(signature.role)
    const name = accountableName(signature.name)
    if (!name) problems.push(`role ${signature.role ?? '?'} has no accountable name`)
    if (Number.isNaN(Date.parse(signature.signedAt))) problems.push(`role ${signature.role ?? '?'} has no signedAt`)
    if (signature.statement !== STATEMENT) problems.push(`role ${signature.role ?? '?'} statement does not match`)
  }
  for (const role of ROLES) if (!seen.has(role)) problems.push(`missing ${role}`)
  const security = signatures.find((signature) => signature?.role === 'security')
  problems.push(...accessReviewProblems(doc.accessReview, accountableName(security?.name)))
  return { status: problems.length === 0 ? 'SIGNED' : 'OPEN', problems }
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function main() {
  const sha = arg('--sha')
  const file = arg('--file') ?? 'docs/ops/staging-acceptance-signoff.json'
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  const result = evaluateSignoff(doc, sha)
  console.log(JSON.stringify({ gate: 'staging-acceptance', ...result }))
  process.exit(result.status === 'SIGNED' ? 0 : 2)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
