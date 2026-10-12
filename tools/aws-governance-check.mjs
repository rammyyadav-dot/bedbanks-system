// WP2 / ADR 0055 governance guard. Static only: reads repository files, needs no AWS credentials and calls no AWS API.
// Fails when the AWS stack drifts from the approved decisions (region, tags, staging exposure, OIDC trust, no apply in CI, booking off, no invented budget).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANDATORY_TAGS = ['Project', 'Environment', 'Owner', 'CostCenter', 'Service', 'ManagedBy']
export const APPROVED_REGION = 'ap-south-1'
const TF = 'infra/aws/terraform'

const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null)
const stripComments = (s) => s.replace(/^\s*(#|\/\/).*$/gm, '').replace(/\s#\s.*$/gm, '')

export function checkGovernance(root = process.cwd()) {
  const v = []
  const fail = (m) => v.push(m)
  const tfFiles = existsSync(join(root, TF)) ? readdirSync(join(root, TF)).filter((f) => f.endsWith('.tf')) : []
  if (!tfFiles.length) return [`${TF}: no Terraform files found`]
  const tf = Object.fromEntries(tfFiles.map((f) => [f, stripComments(read(root, `${TF}/${f}`))]))
  const all = Object.values(tf).join('\n')

  // 1. Mandatory tags on every resource through the provider default_tags.
  const dt = /default_tags\s*\{\s*tags\s*=\s*\{([^}]*)\}/s.exec(tf['versions.tf'] ?? '')
  if (!dt) fail(`${TF}/versions.tf: provider default_tags block missing`)
  else for (const t of MANDATORY_TAGS) if (!new RegExp(`\\b${t}\\s*=`).test(dt[1])) fail(`${TF}/versions.tf: mandatory tag ${t} missing from default_tags`)

  // 2. Approved region in the example tfvars; staging restricted; no uncommented budget ceiling invented.
  for (const env of ['staging', 'production']) {
    const rel = `${TF}/envs/${env}.tfvars.example`
    const raw = read(root, rel)
    if (raw === null) { fail(`${rel}: missing`); continue }
    const src = stripComments(raw)
    const region = /^\s*region\s*=\s*"([^"]+)"/m.exec(src)?.[1]
    if (region !== APPROVED_REGION) fail(`${rel}: region is ${region ?? 'unset'}, ADR 0055 approves ${APPROVED_REGION}`)
    if (/^\s*monthly_budget_usd\s*=\s*[1-9]/m.test(src)) fail(`${rel}: a budget ceiling is set in an example; ceilings are owner-approved parameters`)
    if (env === 'staging') {
      const cidrs = /^\s*public_ingress_cidrs\s*=\s*\[([^\]]*)\]/m.exec(src)?.[1]
      if (cidrs === undefined) fail(`${rel}: public_ingress_cidrs must be set (staging is access-restricted)`)
      else if (cidrs.includes('0.0.0.0/0')) fail(`${rel}: staging must not be open to 0.0.0.0/0`)
    }
    if (env === 'production' && /^\s*create_portal_records\s*=\s*true/m.test(src)) fail(`${rel}: production DNS records must not be enabled in an example`)
  }

  // 3. Guards still present in code.
  if (!/precondition[\s\S]{0,400}public_ingress_cidrs[\s\S]{0,200}0\.0\.0\.0\/0/.test(tf['alb.tf'] ?? '')) fail(`${TF}/alb.tf: staging open-ingress precondition missing`)
  if (!/production_edge_exception_ref/.test(tf['alb.tf'] ?? '')) fail(`${TF}/alb.tf: production edge (CloudFront) precondition missing`)
  if (!/dns_cutover_authorization_ref/.test(tf['dns.tf'] ?? '')) fail(`${TF}/dns.tf: production DNS authorization precondition missing`)
  if (!/variable\s+"create_portal_records"\s*\{[^}]*default\s*=\s*false/s.test(tf['dns.tf'] ?? '')) fail(`${TF}/dns.tf: create_portal_records must default to false`)
  if (!/variable\s+"monthly_budget_usd"\s*\{[^}]*default\s*=\s*0\b/s.test(tf['variables.tf'] ?? '')) fail(`${TF}/variables.tf: monthly_budget_usd must default to 0 (no invented ceiling)`)
  if (!/resource\s+"aws_budgets_budget"/.test(all)) fail(`${TF}: no aws_budgets_budget resource`)

  // 4. Booking, payments and supplier integrations stay off by default; no secret or owner credential material in Terraform.
  if (!/BOOKING_ENABLED\s*=\s*"false"/.test(tf['variables.tf'] ?? '')) fail(`${TF}/variables.tf: BOOKING_ENABLED must default to "false"`)
  if (/\b(PAYMENT|STRIPE|HOLD_EXPIRY)[A-Z_]*\s*=\s*"(true|1)"/.test(all)) fail(`${TF}: payment or hold-expiry flag enabled by default`)
  if (/AKIA[0-9A-Z]{16}|aws_secret_access_key|postgres(ql)?:\/\/[^\s"$]+:[^\s"$@]+@/i.test(all)) fail(`${TF}: credential-like literal found`)
  if (/(MIGRATION|PROVISION|OWNER)_DATABASE_URL/.test(all)) fail(`${TF}: owner database URL referenced in Terraform`)

  // 5. IAM: no wildcard actions or admin policies; OIDC trust pins aud and an exact sub (no wildcard, no StringLike).
  // A wildcard ALLOW is a finding. Exempt only (a) Deny statements, which restrict, and (b) the standard KMS key-policy root statement
  // (sid AccountRootAndIam), which delegates control of that one key to IAM.
  const statements = all.split(/\bstatement\s*\{/).slice(1)
  for (const st of statements) {
    if (!/actions\s*=\s*\[[^\]]*"(\*|[a-z0-9-]+:\*)"/i.test(st)) continue
    if (/effect\s*=\s*"Deny"/.test(st)) continue
    if (/sid\s*=\s*"AccountRootAndIam"/.test(st) && /actions\s*=\s*\["kms:\*"\]/.test(st)) continue
    fail(`${TF}: IAM statement with a wildcard action`)
  }
  if (/AdministratorAccess|PowerUserAccess/.test(all)) fail(`${TF}: broad managed policy attached`)
  const trust = /data\s+"aws_iam_policy_document"\s+"github_trust"[\s\S]*?\n}\n/.exec(tf['iam.tf'] ?? '')?.[0]
  if (!trust) fail(`${TF}/iam.tf: github_trust OIDC policy missing`)
  else {
    if (/StringLike/.test(trust)) fail(`${TF}/iam.tf: OIDC trust must use StringEquals, not StringLike`)
    if (!/token\.actions\.githubusercontent\.com:aud/.test(trust)) fail(`${TF}/iam.tf: OIDC trust does not pin the audience`)
    if (!/token\.actions\.githubusercontent\.com:sub/.test(trust)) fail(`${TF}/iam.tf: OIDC trust does not pin the subject`)
    if (/repo:[^"]*\*/.test(trust)) fail(`${TF}/iam.tf: OIDC subject contains a wildcard`)
  }
  if (!/repo:\$\{var\.github_repository\}:ref:refs\/heads\/main/.test(tf['iam.tf'] ?? '')) fail(`${TF}/iam.tf: build role must be assumable only from main`)
  if (!/repo:\$\{var\.github_repository\}:environment:\$\{var\.environment\}/.test(tf['iam.tf'] ?? '')) fail(`${TF}/iam.tf: deploy role must be bound to the GitHub environment`)

  // 6. Workflows: nothing applies or destroys infrastructure, no long-lived AWS keys.
  const wfDir = join(root, '.github/workflows')
  for (const f of existsSync(wfDir) ? readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)) : []) {
    const src = stripComments(readFileSync(join(wfDir, f), 'utf8'))
    if (/terraform[^\n]*\b(apply|destroy)\b/.test(src)) fail(`.github/workflows/${f}: runs terraform apply/destroy (apply is an owner action, never CI)`)
    if (/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws-access-key-id/i.test(src)) fail(`.github/workflows/${f}: long-lived AWS keys; use OIDC`)
  }

  // 6b. WP3: secrets hygiene. Secret material may be in state ONLY where documented; outputs never carry it.
  const allowedGenerated = new Set(['redis_auth', 'origin_verify'])
  for (const m of all.matchAll(/resource\s+"random_password"\s+"([^"]+)"/g)) if (!allowedGenerated.has(m[1])) fail(`${TF}: undeclared generated secret random_password.${m[1]} (secret material in state needs a documented exception)`)
  for (const m of all.matchAll(/resource\s+"aws_secretsmanager_secret_version"\s+"([^"]+)"/g)) if (m[1] !== 'redis_url') fail(`${TF}: aws_secretsmanager_secret_version.${m[1]} writes a secret value from Terraform; only redis_url is documented`)
  for (const m of (tf['outputs.tf'] ?? '').matchAll(/output\s+"([^"]+)"\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
    if (/random_password|\.result\b|secret_string|secret_version|master_user_secret\[0\]\.secret_arn|auth_token|\bpassword\b/i.test(m[2].replace(/\.arn\b/g, ''))) fail(`${TF}/outputs.tf: output "${m[1]}" references secret material`)
  }
  if (/auth_token\s*=\s*"/.test(all) || /redis_auth_token\s*=\s*"[^"]/.test(all)) fail(`${TF}: literal Redis auth token`)

  if (!/backend\s+"s3"\s*\{[^}]*encrypt\s*=\s*true/.test(tf['versions.tf'] ?? '')) fail(`${TF}/versions.tf: the S3 backend must set encrypt = true (state holds the documented generated secrets)`)

  // 6c. WP3: logging, private data tier, encryption.
  const t = (f) => tf[f] ?? ''
  if (!/publicly_accessible\s*=\s*false/.test(t('data.tf'))) fail(`${TF}/data.tf: RDS must set publicly_accessible = false`)
  if (!/storage_encrypted\s*=\s*true/.test(t('data.tf'))) fail(`${TF}/data.tf: RDS storage must be encrypted`)
  if (!/transit_encryption_enabled\s*=\s*true/.test(t('data.tf')) || !/at_rest_encryption_enabled\s*=\s*true/.test(t('data.tf'))) fail(`${TF}/data.tf: Redis must be encrypted in transit and at rest`)
  if (!/auth_token\s*=\s*random_password\.redis_auth\.result/.test(t('data.tf'))) fail(`${TF}/data.tf: Redis AUTH token missing`)
  if (!/enabled_cloudwatch_logs_exports\s*=\s*\["postgresql",\s*"upgrade"\]/.test(t('data.tf')) || !/monitoring_interval\s*=\s*[1-9]/.test(t('data.tf'))) fail(`${TF}/data.tf: RDS log exports and Enhanced Monitoring required`)
  if (!/policy\s*=\s*data\.aws_iam_policy_document\.kms_data\.json/.test(t('data.tf'))) fail(`${TF}/data.tf: KMS key policy must be explicit (CloudWatch Logs and alarms)`)
  if (/alias\/aws\/sns/.test(all.replace(/#[^\n]*/g, ''))) fail(`${TF}: SNS topic must not use alias/aws/sns (CloudWatch alarms cannot publish to it)`)
  if (!/resource\s+"aws_flow_log"/.test(t('logging.tf'))) fail(`${TF}/logging.tf: VPC flow logs missing`)
  if ((t('alb.tf').match(/access_logs\s*\{[^}]*enabled\s*=\s*true/g) ?? []).length !== 2) fail(`${TF}/alb.tf: both ALBs need access_logs enabled`)
  const wafLogs = (t('logging.tf') + t('edge.tf')).match(/resource\s+"aws_wafv2_web_acl_logging_configuration"[\s\S]*?\n}\n/g) ?? []
  if (wafLogs.length < 2) fail(`${TF}: WAF logging missing for the regional and CloudFront ACLs`)
  for (const w of wafLogs) if (!/name\s*=\s*"authorization"/.test(w) || !/name\s*=\s*"cookie"/.test(w)) fail(`${TF}: a WAF logging configuration does not redact authorization and cookie`)
  const lb = /resource\s+"aws_s3_bucket_public_access_block"\s+"alb_logs"[\s\S]*?\n}\n/.exec(t('logging.tf'))?.[0] ?? ''
  if ((lb.match(/=\s*true/g) ?? []).length !== 4) fail(`${TF}/logging.tf: ALB log bucket must block all public access`)
  if (!/aws:SecureTransport/.test(t('logging.tf'))) fail(`${TF}/logging.tf: ALB log bucket must deny non-TLS access`)
  if (/retention_in_days\s*=\s*0\b/.test(all)) fail(`${TF}: a log group with unlimited retention`)
  for (const m of all.matchAll(/resource\s+"aws_cloudwatch_log_group"\s+"([^"]+)"\s*\{([\s\S]*?)\n}\n/g)) if (!/retention_in_days/.test(m[2])) fail(`${TF}: log group ${m[1]} has no explicit retention`)
  if (/cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/.test(t('network.tf').replace(/resource "aws_vpc_security_group_egress_rule" "https_out"[\s\S]*?\n}\n/, ''))) fail(`${TF}/network.tf: a world-open security-group rule outside the documented HTTPS egress`)

  // 6d. WP3: CloudFront edge. Only /_next/static/* may be cached; HTTPS everywhere; origin protected in layers.
  const edge = t('edge.tf')
  const behaviors = [...edge.matchAll(/(default_cache_behavior|ordered_cache_behavior)\s*\{([\s\S]*?)\n  }\n/g)]
  if (behaviors.length !== 3) fail(`${TF}/edge.tf: expected default + /api/v1/* + /_next/static/* behaviors, found ${behaviors.length}`)
  for (const [, kind, body] of behaviors) {
    const path = /path_pattern\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? '(default)'
    const policy = /cache_policy_id\s*=\s*data\.aws_cloudfront_cache_policy\.(\w+)\[0\]\.id/.exec(body)?.[1]
    if (!/viewer_protocol_policy\s*=\s*"redirect-to-https"/.test(body)) fail(`${TF}/edge.tf: behavior ${path} must redirect HTTP to HTTPS`)
    if (!/response_headers_policy_id/.test(body)) fail(`${TF}/edge.tf: behavior ${path} has no response headers policy`)
    const expected = path === '/_next/static/*' ? 'optimized' : 'disabled'
    if (policy !== expected) fail(`${TF}/edge.tf: behavior ${path} uses cache policy "${policy}", must be "${expected}" (only immutable build assets may be shared-cached)`)
    if (path === '/_next/static/*' && /"(POST|PUT|PATCH|DELETE)"/.test(body)) fail(`${TF}/edge.tf: cached path must not allow mutating methods`)
  }
  if (edge && !/origin_protocol_policy\s*=\s*"https-only"/.test(edge)) fail(`${TF}/edge.tf: CloudFront must reach the origin over HTTPS only`)
  if (edge && !/minimum_protocol_version\s*=\s*"TLSv1\.2_2021"/.test(edge)) fail(`${TF}/edge.tf: viewer TLS must be TLSv1.2_2021 or newer`)
  if (edge && !/web_acl_id\s*=\s*aws_wafv2_web_acl\.edge\[0\]\.arn/.test(edge)) fail(`${TF}/edge.tf: distributions must attach the CLOUDFRONT web ACL`)
  if (edge && !/name\s*=\s*"X-Origin-Verify"/.test(edge)) fail(`${TF}/edge.tf: origin verification header missing`)
  if (edge && !/AWSManagedRulesKnownBadInputsRuleSet/.test(edge)) fail(`${TF}/edge.tf: edge WAF lacks the known-bad-inputs managed rules`)
  if (edge && !/ip_set_reference_statement/.test(edge)) fail(`${TF}/edge.tf: staging edge allow-list missing`)
  if (!/http_header_name\s*=\s*"X-Origin-Verify"/.test(t('alb.tf'))) fail(`${TF}/alb.tf: listener rules must require X-Origin-Verify when CloudFront is enabled`)
  if (!/prefix_list_id\s*=\s*data\.aws_ec2_managed_prefix_list\.cloudfront\[0\]\.id/.test(t('network.tf'))) fail(`${TF}/network.tf: ALB must admit only the CloudFront prefix list when the edge is enabled`)
  if (!/var\.environment\s*!=\s*"production"\s*\|\|\s*var\.cloudfront_enabled\s*\|\|\s*trimspace\(var\.production_edge_exception_ref\)/.test(t('alb.tf'))) fail(`${TF}/alb.tf: production release guard (CloudFront or approved exception) missing`)

  // 6e. WP3: the CI roles can never run the owner-credential migration (regression lock for the WP2 fix).
  const deployPolicy = /data\s+"aws_iam_policy_document"\s+"github_deploy"[\s\S]*?\n}\n/.exec(t('iam.tf'))?.[0] ?? ''
  if (/ecs:RunTask/.test(deployPolicy) || /migrate_execution/.test(deployPolicy)) fail(`${TF}/iam.tf: the CI deploy role must not run tasks or pass the migrate role`)
  if (!/iam:PassedToService/.test(deployPolicy)) fail(`${TF}/iam.tf: iam:PassRole must be constrained to ecs-tasks.amazonaws.com`)

  // 6f. WP3: immutable image promotion. The portals' build must not depend on the API origin.
  const dockerfile = read(root, 'Dockerfile.web')
  if (dockerfile !== null) for (const a of ['API_INTERNAL_URL', 'AUTH_API_ORIGIN', 'SUPPLIER_ORIGIN', 'AUTH_COOKIE_NAME']) if (new RegExp(`ARG\\s+${a}\\b`).test(dockerfile)) fail(`Dockerfile.web: build arg ${a} would tie an image to one environment (ADR 0055)`)
  for (const app of ['agent', 'admin', 'supplier']) {
    const cfg = read(root, `apps/${app}/next.config.mjs`)
    if (cfg !== null && /rewrites\s*\(/.test(stripComments(cfg))) fail(`apps/${app}/next.config.mjs: a build-time rewrite freezes the API origin (use proxy.ts)`)
    const proxy = read(root, `apps/${app}/proxy.ts`)
    if (proxy !== null && !/resolveApiDestination/.test(proxy)) fail(`apps/${app}/proxy.ts: must resolve the API origin per request`)
  }

  // 6f2. Operator scripts under infra/aws are read-only: none may invoke terraform apply/destroy (a human applies, with approval).
  for (const dir of ['infra/aws', 'infra/aws/audit', 'infra/aws/express']) {
    const abs = join(root, dir)
    for (const f of existsSync(abs) ? readdirSync(abs).filter((n) => n.endsWith('.sh')) : []) {
      const body = readFileSync(join(abs, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''")
      if (/terraform[^\n]*\b(apply|destroy)\b|\btf\s+(apply|destroy)\b/.test(body)) fail(`${dir}/${f}: operator script runs terraform apply/destroy (apply is a human action with approval)`)
    }
  }

  // 6g. WP3: every checkov skip is a registered, reasoned exception.
  const ck = read(root, `${TF}/.checkov.yaml`)
  const register = read(root, 'docs/aws-checkov-exception-register.md')
  if (ck !== null) {
    for (const m of ck.matchAll(/^\s*-\s+(CKV2?_AWS_\d+)\s*(#\s*(.*))?$/gm)) {
      if (!m[3] || m[3].trim().length < 15) fail(`${TF}/.checkov.yaml: skip ${m[1]} has no reason`)
      if (register === null || !register.includes(m[1])) fail(`${TF}/.checkov.yaml: skip ${m[1]} is not in docs/aws-checkov-exception-register.md`)
    }
  }

  // 7. ADR 0055 records the decisions.
  const adr = read(root, 'docs/adr/0055-aws-region-edge-exposure-and-release-governance.md')
  if (adr === null) fail('docs/adr/0055-aws-region-edge-exposure-and-release-governance.md missing')
  else for (const needle of [APPROVED_REGION, 'CloudFront', 'digest', 'access-restricted', 'cutover']) if (!adr.includes(needle)) fail(`ADR 0055 does not mention "${needle}"`)
  return v
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkGovernance()
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exit(1)
  }
  console.log('AWS governance check passed (static; no AWS access).')
}
