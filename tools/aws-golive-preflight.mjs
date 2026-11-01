// Production go-live preflight (docs/aws-ecs-go-live-audit-2026-10-21.md). Static: reads the operator's untracked production tfvars, needs no AWS
// credentials and calls no API. It does not replace the reviewed `terraform plan`; it refuses the obvious ways a production apply or DNS cutover
// is premature. Usage: node tools/aws-golive-preflight.mjs path/to/production.tfvars
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const strip = (s) => s.replace(/^\s*(#|\/\/).*$/gm, '').replace(/\s#\s.*$/gm, '')
const str = (src, key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(src)?.[1]
const raw = (src, key) => new RegExp(`^\\s*${key}\\s*=\\s*([^\\s]+)`, 'm').exec(src)?.[1]
const bool = (src, key, dflt) => { const v = raw(src, key); return v === undefined ? dflt : v === 'true' }
const num = (src, key, dflt) => { const v = raw(src, key); return v === undefined ? dflt : Number(v) }

/** Returns [{ gate, ok, detail }]. Defaults mirror infra/aws/terraform/variables.tf. */
export function checkGoLive(tfvars) {
  const src = strip(tfvars)
  const r = []
  const gate = (name, ok, detail) => r.push({ gate: name, ok: Boolean(ok), detail })
  gate('environment is production', str(src, 'environment') === 'production', `environment = ${str(src, 'environment') ?? 'unset'}`)
  gate('region is ap-south-1 (ADR 0055)', str(src, 'region') === 'ap-south-1', `region = ${str(src, 'region') ?? 'unset'}`)
  gate('hosted zone id is real', /^Z[0-9A-Z]{8,}$/.test(str(src, 'hosted_zone_id') ?? '') && !/^ZX+$/.test(str(src, 'hosted_zone_id') ?? ''), 'hosted_zone_id must be the Route 53 zone, not the example placeholder')
  gate('edge: CloudFront or recorded exception (ADR 0055)', bool(src, 'cloudfront_enabled', false) || (str(src, 'production_edge_exception_ref') ?? '').trim() !== '', 'cloudfront_enabled = true, or production_edge_exception_ref')
  gate('database is Multi-AZ', bool(src, 'db_multi_az', true), 'db_multi_az must not be false in production')
  gate('one NAT gateway per AZ', bool(src, 'nat_per_az', false), 'nat_per_az = true (the default is the single shared NAT used for staging)')
  gate('API and portals run at least two tasks', num(src, 'api_desired_count', 2) >= 2 && num(src, 'portal_desired_count', 2) >= 2, 'desired counts below 2 remove zone redundancy')
  gate('image is a pinned commit, not bootstrap', /^[0-9a-f]{40}$/.test(str(src, 'initial_image_tag') ?? ''), `initial_image_tag = ${str(src, 'initial_image_tag') ?? 'unset (defaults to bootstrap)'}`)
  gate('owner-approved budget ceiling and recipients', num(src, 'monthly_budget_usd', 0) > 0 && /budget_emails\s*=\s*\[\s*"[^"]+"/.test(src), 'monthly_budget_usd > 0 and budget_emails set')
  gate('alarm subscriber set', (str(src, 'alarm_email') ?? '').includes('@'), 'alarm_email, or alarms page nobody')
  gate('booking stays disabled', !/BOOKING_(SERVICING_)?ENABLED\s*=\s*"true"/.test(src), 'BOOKING_ENABLED or BOOKING_SERVICING_ENABLED = "true" needs its own owner decision (ADR 0055 #6, ADR 0101)')
  const dns = bool(src, 'create_portal_records', false)
  gate('DNS records only with a recorded CTO GO', !dns || (str(src, 'dns_cutover_authorization_ref') ?? '').trim() !== '', dns ? 'create_portal_records = true requires dns_cutover_authorization_ref' : 'create_portal_records = false (no cutover yet)')
  return r
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node tools/aws-golive-preflight.mjs <production.tfvars>'); process.exit(2) }
  const results = checkGoLive(readFileSync(file, 'utf8'))
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.gate}${x.ok ? '' : `: ${x.detail}`}`)
  const failed = results.filter((x) => !x.ok).length
  console.log(failed ? `\n${failed} gate(s) failed: NOT ready for a production apply.` : '\nAll static gates pass. A reviewed real `terraform plan`, staging soak evidence and the CTO GO are still required.')
  process.exit(failed ? 1 : 0)
}
