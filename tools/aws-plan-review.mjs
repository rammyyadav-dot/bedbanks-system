#!/usr/bin/env node
// Mechanical first pass over a Terraform plan (`terraform show -json plan.bin > plan.json`). It never replaces a human reading the plan:
// it FAILS on dangerous content (exit 1) and lists items a person must look at (REVIEW). Read-only: it only parses the JSON file.
// Usage: node tools/aws-plan-review.mjs plan.json [--expect-region ap-south-1]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MANDATORY_TAGS = ['Project', 'Environment', 'Owner', 'CostCenter', 'Service', 'ManagedBy']
const STATEFUL = new Set(['aws_db_instance', 'aws_elasticache_replication_group', 'aws_kms_key', 'aws_s3_bucket', 'aws_secretsmanager_secret', 'aws_ecr_repository', 'aws_route53_zone', 'aws_cloudwatch_log_group'])
const SECRET_NAME = /secret|password|token|credential|auth/i

const stmts = (json) => {
  try {
    const doc = typeof json === 'string' ? JSON.parse(json) : json
    const s = doc?.Statement
    return Array.isArray(s) ? s : s ? [s] : []
  } catch { return [] }
}
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])

export function reviewPlan(plan, { expectRegion = 'ap-south-1' } = {}) {
  const fail = []
  const review = []
  const changes = plan.resource_changes ?? []
  const env = plan.variables?.environment?.value
  const counts = { create: 0, update: 0, delete: 0, replace: 0, noop: 0 }

  const region = plan.configuration?.provider_config?.aws?.expressions?.region?.constant_value ?? plan.variables?.region?.value
  if (region !== undefined && region !== expectRegion) fail.push(`region is "${region}", expected "${expectRegion}" (ADR 0055)`)
  if (env !== 'staging' && env !== 'production') fail.push(`variable environment is "${env}"; it must be staging or production`)

  for (const rc of changes) {
    const actions = rc.change?.actions ?? []
    const after = rc.change?.after ?? {}
    const addr = rc.address
    if (actions.includes('delete') && actions.includes('create')) counts.replace++
    else if (actions.includes('delete')) counts.delete++
    else if (actions.includes('create')) counts.create++
    else if (actions.includes('update')) counts.update++
    else counts.noop++

    if (actions.includes('delete') && STATEFUL.has(rc.type)) fail.push(`${addr}: ${actions.includes('create') ? 'REPLACE' : 'DESTROY'} of a stateful resource (data or keys would be lost)`)
    else if (actions.includes('delete')) review.push(`${addr}: ${actions.join('+')}`)
    else if (actions.includes('update') && STATEFUL.has(rc.type)) review.push(`${addr}: in-place update of a stateful resource`)
    if (actions.every((a) => a === 'no-op' || a === 'read')) continue

    if (rc.type === 'aws_db_instance') {
      if (after.publicly_accessible === true) fail.push(`${addr}: RDS is publicly accessible`)
      if (after.storage_encrypted === false) fail.push(`${addr}: RDS storage is not encrypted`)
      if (env === 'production' && after.multi_az === false) fail.push(`${addr}: production RDS is single-AZ`)
      if (env === 'production' && after.deletion_protection === false) fail.push(`${addr}: production RDS has no deletion protection`)
      if (after.iam_database_authentication_enabled === true) review.push(`${addr}: IAM database auth enabled (changes the auth boundary of ADR 0040/0008)`)
    }
    if (rc.type === 'aws_elasticache_replication_group') {
      if (after.transit_encryption_enabled === false || after.at_rest_encryption_enabled === false) fail.push(`${addr}: Redis is not encrypted in transit and at rest`)
      if (rc.change?.after_sensitive?.auth_token !== true && !after.auth_token) fail.push(`${addr}: Redis AUTH token missing from the plan`)
    }
    if (rc.type === 'aws_vpc_security_group_ingress_rule' && after.cidr_ipv4 === '0.0.0.0/0') {
      if (env === 'staging') fail.push(`${addr}: world-open ingress in STAGING (ADR 0055: staging is access-restricted)`)
      else review.push(`${addr}: world-open ingress on ${after.from_port}-${after.to_port} (acceptable only if CloudFront is not enabled and the production exception is approved)`)
    }
    if (rc.type === 'aws_ecs_service' && asArray(after.network_configuration).some((n) => n?.assign_public_ip === true)) fail.push(`${addr}: ECS tasks get public IPs`)
    if (rc.type === 'aws_route53_record') {
      const recordType = after.type
      if (recordType === 'A' || recordType === 'AAAA') review.push(`${addr}: PUBLIC/ALIAS DNS record "${after.name}" (cutover step: needs the recorded authorization, never for production without it)`)
    }
    if (rc.type === 'aws_budgets_budget') review.push(`${addr}: budget limit ${after.limit_amount} ${after.limit_unit} (must be the owner-approved value)`)
    if (rc.type === 'aws_cloudfront_distribution') review.push(`${addr}: CloudFront distribution for ${asArray(after.aliases).join(', ')}`)
    if (rc.type === 'aws_wafv2_web_acl' && after.scope === 'CLOUDFRONT') review.push(`${addr}: CLOUDFRONT-scope WAF (us-east-1)`)

    // IAM: a wildcard ALLOW is a failure, except the key-policy root statement on a KMS key.
    if (['aws_iam_role_policy', 'aws_iam_policy', 'aws_kms_key', 'aws_s3_bucket_policy', 'aws_cloudwatch_log_resource_policy'].includes(rc.type)) {
      const doc = after.policy ?? after.policy_document
      for (const st of stmts(doc)) {
        const acts = asArray(st.Action).map(String)
        const wildcard = acts.some((a) => a === '*' || /^[a-z0-9-]+:\*$/i.test(a))
        if (!wildcard || st.Effect === 'Deny') continue
        if (rc.type === 'aws_kms_key' && st.Sid === 'AccountRootAndIam') continue
        fail.push(`${addr}: Allow statement with wildcard action ${JSON.stringify(acts)}`)
      }
    }
    if (rc.type === 'aws_iam_role') {
      for (const st of stmts(after.assume_role_policy)) {
        const subs = JSON.stringify(st.Condition ?? {})
        if (/githubusercontent/.test(JSON.stringify(st.Principal ?? {})) && (/StringLike/.test(subs) || /repo:[^"]*\*/.test(subs))) fail.push(`${addr}: GitHub OIDC trust uses a wildcard or StringLike subject`)
      }
    }
    // Mandatory governance tags on everything that carries tags_all (values can be unknown at plan time; a missing KEY is a failure).
    const tags = after.tags_all
    if (tags && typeof tags === 'object') {
      const missing = MANDATORY_TAGS.filter((t) => !(t in tags))
      if (missing.length) fail.push(`${addr}: missing mandatory tag(s) ${missing.join(', ')}`)
    }
  }

  for (const [name, oc] of Object.entries(plan.output_changes ?? {})) {
    if (SECRET_NAME.test(name) && !oc.after_sensitive && !/arn|id|name|url|endpoint$/i.test(name)) fail.push(`output "${name}" looks like secret material and is not marked sensitive`)
  }
  if (counts.delete + counts.replace + counts.update > 0) review.push(`this plan updates/deletes/replaces resources (update ${counts.update}, delete ${counts.delete}, replace ${counts.replace}): confirm that is intended`)
  return { env, region, counts, fail, review }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node tools/aws-plan-review.mjs plan.json [--expect-region ap-south-1]'); process.exit(2) }
  const i = process.argv.indexOf('--expect-region')
  const r = reviewPlan(JSON.parse(readFileSync(file, 'utf8')), { expectRegion: i > 0 ? process.argv[i + 1] : 'ap-south-1' })
  console.log(`environment=${r.env} region=${r.region ?? '(from provider default)'} create=${r.counts.create} update=${r.counts.update} delete=${r.counts.delete} replace=${r.counts.replace}`)
  for (const x of r.review) console.log(`REVIEW  ${x}`)
  for (const x of r.fail) console.error(`FAIL    ${x}`)
  console.log(r.fail.length ? `\n${r.fail.length} blocking finding(s). Do NOT apply.` : '\nNo blocking findings. This does not replace reading the plan: every REVIEW line needs a human decision.')
  process.exit(r.fail.length ? 1 : 0)
}
