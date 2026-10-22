import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkGoLive } from './aws-golive-preflight.mjs'

const READY = `
region = "ap-south-1"
environment = "production"
domain_name = "fbeds.com"
hosted_zone_id = "Z0123456789ABCDEF"
nat_per_az = true
cloudfront_enabled = true
initial_image_tag = "${'a'.repeat(40)}"
monthly_budget_usd = 5000
budget_emails = ["finops@fbeds.com"]
alarm_email = "oncall@fbeds.com"
`
const failing = (tfvars) => checkGoLive(tfvars).filter((x) => !x.ok).map((x) => x.gate)

test('a fully specified production file passes every gate', () => assert.deepEqual(failing(READY), []))
test('the shipped example is refused (placeholders, no edge, bootstrap image, no budget)', () => {
  const f = failing(readFileSync('infra/aws/terraform/envs/production.tfvars.example', 'utf8'))
  for (const g of ['hosted zone id is real', 'edge: CloudFront or recorded exception (ADR 0055)', 'image is a pinned commit, not bootstrap', 'owner-approved budget ceiling and recipients', 'alarm subscriber set']) assert.ok(f.includes(g), g)
})
test('commented-out values do not count', () => assert.ok(failing(READY.replace('cloudfront_enabled = true', '# cloudfront_enabled = true')).some((g) => g.startsWith('edge'))))
test('an exception reference satisfies the edge gate', () => assert.deepEqual(failing(READY.replace('cloudfront_enabled = true', 'production_edge_exception_ref = "ADR-0055-exception-1"')), []))
test('single-AZ database and single NAT are refused', () => {
  assert.deepEqual(failing(`${READY}db_multi_az = false\n`), ['database is Multi-AZ'])
  assert.deepEqual(failing(READY.replace('nat_per_az = true', 'nat_per_az = false')), ['one NAT gateway per AZ'])
})
test('one task per service is refused', () => assert.deepEqual(failing(`${READY}api_desired_count = 1\n`), ['API and portals run at least two tasks']))
test('booking enabled is refused', () => assert.deepEqual(failing(`${READY}api_env = {\n  BOOKING_ENABLED = "true"\n}\n`), ['booking stays disabled']))
test('DNS records need the recorded GO', () => {
  assert.deepEqual(failing(`${READY}create_portal_records = true\n`), ['DNS records only with a recorded CTO GO'])
  assert.deepEqual(failing(`${READY}create_portal_records = true\ndns_cutover_authorization_ref = "CTO-GO-2026-11-01"\n`), [])
})
test('a staging file is refused', () => assert.ok(failing(READY.replace('production', 'staging')).includes('environment is production')))
