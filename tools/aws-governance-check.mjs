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
  if (/actions\s*=\s*\[[^\]]*"(\*|[a-z0-9-]+:\*)"/i.test(all)) fail(`${TF}: IAM statement with a wildcard action`)
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
