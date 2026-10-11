import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkGovernance } from './aws-governance-check.mjs'

const mutate = (edits) => {
  const dir = mkdtempSync(join(tmpdir(), 'aws-gov-'))
  cpSync('infra/aws/terraform', join(dir, 'infra/aws/terraform'), { recursive: true, filter: (s) => !s.includes('.terraform') })
  cpSync('.github/workflows', join(dir, '.github/workflows'), { recursive: true })
  cpSync('docs/adr', join(dir, 'docs/adr'), { recursive: true })
  for (const [file, from, to] of edits) {
    const p = join(dir, file)
    const before = readFileSync(p, 'utf8')
    assert.ok(before.includes(from), `fixture drift: "${from}" not in ${file}`)
    writeFileSync(p, before.replaceAll(from, to))
  }
  try { return checkGovernance(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const T = 'infra/aws/terraform'

test('repository passes', () => assert.deepEqual(checkGovernance(), []))
test('missing mandatory tag', () => assert.match(mutate([[`${T}/versions.tf`, 'CostCenter = var.cost_center', '']]).join('\n'), /CostCenter/))
test('wrong region', () => assert.match(mutate([[`${T}/envs/staging.tfvars.example`, '"ap-south-1"', '"eu-central-1"']]).join('\n'), /region/))
test('staging opened to the world', () => assert.match(mutate([[`${T}/envs/staging.tfvars.example`, '["203.0.113.0/24"]', '["0.0.0.0/0"]']]).join('\n'), /0\.0\.0\.0\/0/))
test('budget ceiling invented in an example', () => assert.match(mutate([[`${T}/envs/staging.tfvars.example`, 'region ', 'monthly_budget_usd = 500\nregion ']]).join('\n'), /ceiling/))
test('DNS authorization guard removed', () => assert.match(mutate([[`${T}/dns.tf`, 'dns_cutover_authorization_ref', 'x']]).join('\n'), /authorization/))
test('portal records default on', () => assert.match(mutate([[`${T}/dns.tf`, 'default     = false', 'default     = true']]).join('\n'), /create_portal_records/))
test('booking enabled by default', () => assert.match(mutate([[`${T}/variables.tf`, 'BOOKING_ENABLED = "false"', 'BOOKING_ENABLED = "true"']]).join('\n'), /BOOKING_ENABLED/))
test('OIDC subject wildcard', () => assert.match(mutate([[`${T}/iam.tf`, 'ref:refs/heads/main', 'ref:refs/heads/*']]).join('\n'), /wildcard|main/))
test('OIDC StringLike', () => assert.match(mutate([[`${T}/iam.tf`, 'test     = "StringEquals"\n      variable = "token.actions.githubusercontent.com:sub"', 'test     = "StringLike"\n      variable = "token.actions.githubusercontent.com:sub"']]).join('\n'), /StringLike/))
test('wildcard IAM action', () => assert.match(mutate([[`${T}/iam.tf`, 'actions   = ["ecs:UpdateService"]', 'actions   = ["ecs:*"]']]).join('\n'), /wildcard action/))
test('terraform apply in a workflow', () => assert.match(mutate([['.github/workflows/terraform-check.yml', 'validate', 'validate\n      - run: terraform apply -auto-approve']]).join('\n'), /apply/))
test('long-lived AWS keys in a workflow', () => assert.match(mutate([['.github/workflows/aws-deploy.yml', 'aws-actions/configure-aws-credentials@v4', 'aws-actions/configure-aws-credentials@v4\n        env:\n          AWS_ACCESS_KEY_ID: x']]).join('\n'), /long-lived/))
test('owner database URL in Terraform', () => assert.match(mutate([[`${T}/variables.tf`, 'BOOKING_ENABLED = "false"', 'BOOKING_ENABLED = "false"\n    MIGRATION_DATABASE_URL = "x"']]).join('\n'), /owner database/))
