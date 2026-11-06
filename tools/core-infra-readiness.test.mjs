import assert from 'node:assert/strict'
import test from 'node:test'
import { OBSERVED_2026_11_06, assess } from './core-infra-readiness.mjs'

test('the 6 November 2026 observation does not support 92% or on-track', () => {
  const result = assess(OBSERVED_2026_11_06)
  assert.equal(result.reportedCompletionSupported, false)
  assert.equal(result.onTrackSupported, false)
  for (const id of ['public-www', 'public-apex', 'portal-dns', 'portal-apps', 'aws', 'database', 'search-budget', 'booking']) {
    assert.ok(result.blocking.includes(id), id)
  }
  const split = Object.fromEntries(result.split.map((row) => [row.role, row]))
  assert.equal(split.Hostinger.provider, 'No hosting role found')
  assert.equal(split.Cloudflare.provider, 'Not the DNS host and not the HTTP proxy')
  assert.match(split['Authoritative DNS'].evidence, /rediffmailpro/)
  assert.match(split['www.fbeds.com'].evidence, /DEPLOYMENT_NOT_FOUND/)
})

test('a fully evidenced surface supports the reported status', () => {
  const ready = structuredClone(OBSERVED_2026_11_06)
  ready.apexTitle = 'fBeds'
  ready.wwwStatus = 200
  ready.wwwError = null
  ready.portalDns = { 'agent.fbeds.com': 'present', 'admin.fbeds.com': 'present', 'supplier.fbeds.com': 'present', 'api.fbeds.com': 'private' }
  ready.vercel.projectCount = 4
  ready.vercel.live = true
  ready.vercel.latestProductionState = 'READY'
  ready.vercel.aliasTitles = { 'agent.example': 'Agent', 'admin.example': 'Admin', 'supplier.example': 'Supplier' }
  ready.awsApplyRecorded = true
  ready.databaseOwnerSigned = true
  ready.neonContacted = true
  ready.searchBudgetMet = true
  ready.bookingCertifiedLive = true
  const result = assess(ready)
  assert.deepEqual(result.blocking, [])
  assert.equal(result.reportedCompletionSupported, true)
  assert.equal(result.findings.find((f) => f.id === 'hostinger').blocking, false)
  assert.equal(result.findings.find((f) => f.id === 'cloudflare').blocking, false)
})
