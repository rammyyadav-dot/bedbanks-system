import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkGovernance } from './aws-governance-check.mjs'

const mutate = (edits) => {
  const dir = mkdtempSync(join(tmpdir(), 'aws-gov-'))
  cpSync('infra/aws/terraform', join(dir, 'infra/aws/terraform'), { recursive: true, filter: (s) => !s.includes('.terraform') })
  cpSync('.github/workflows', join(dir, '.github/workflows'), { recursive: true })
  cpSync('docs/adr', join(dir, 'docs/adr'), { recursive: true })
  cpSync('Dockerfile.web', join(dir, 'Dockerfile.web'))
  cpSync('docs/aws-checkov-exception-register.md', join(dir, 'docs/aws-checkov-exception-register.md'))
  for (const app of ['agent', 'admin', 'supplier']) {
    mkdirSync(join(dir, 'apps', app), { recursive: true })
    for (const f of ['next.config.mjs', 'proxy.ts']) cpSync(`apps/${app}/${f}`, join(dir, 'apps', app, f))
  }
  for (const [file, from, to] of edits) {
    const p = join(dir, file)
    const before = readFileSync(p, 'utf8')
    assert.ok(from instanceof RegExp ? from.test(before) : before.includes(from), `fixture drift: "${from}" not in ${file}`)
    writeFileSync(p, from instanceof RegExp ? before.replace(from, to) : before.replaceAll(from, to))
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

// ---- WP3 rules ----
const match = (edits, re) => assert.match(mutate(edits).join('\n'), re)
test('WP3: an output that exposes secret material', () => match([[`${T}/outputs.tf`, 'output "cluster_name" { value = aws_ecs_cluster.this.name }', 'output "cluster_name" { value = aws_ecs_cluster.this.name }\noutput "leak" { value = random_password.redis_auth.result }']], /references secret material/))
test('WP3: an undeclared generated secret', () => match([[`${T}/data.tf`, 'resource "random_password" "redis_auth" {', 'resource "random_password" "sneaky" {\n  length = 8\n}\nresource "random_password" "redis_auth" {']], /undeclared generated secret/))
test('WP3: a second secret value written from Terraform', () => match([[`${T}/secrets.tf`, 'resource "aws_secretsmanager_secret_version" "redis_url" {', 'resource "aws_secretsmanager_secret_version" "db" {\n  secret_id = "x"\n  secret_string = "y"\n}\nresource "aws_secretsmanager_secret_version" "redis_url" {']], /only redis_url/))
test('WP3: public RDS', () => match([[`${T}/data.tf`, 'publicly_accessible                 = false', 'publicly_accessible                 = true']], /publicly_accessible/))
test('WP3: Redis without AUTH', () => match([[`${T}/data.tf`, 'auth_token                 = random_password.redis_auth.result', '']], /AUTH token missing/))
test('WP3: Redis without TLS', () => match([[`${T}/data.tf`, 'transit_encryption_enabled = true', 'transit_encryption_enabled = false']], /encrypted in transit/))
test('WP3: RDS log export removed', () => match([[`${T}/data.tf`, 'enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]', '']], /log exports/))
test('WP3: alarm topic on the AWS-managed SNS key', () => match([[`${T}/observability.tf`, 'kms_master_key_id = aws_kms_key.data.arn', 'kms_master_key_id = "alias/aws/sns"']], /alias\/aws\/sns/))
test('WP3: flow logs removed', () => match([[`${T}/logging.tf`, 'resource "aws_flow_log" "vpc"', 'resource "aws_flow_log_disabled" "vpc"']], /flow logs missing/))
test('WP3: ALB access logs off', () => match([[`${T}/alb.tf`, 'enabled = true', 'enabled = false']], /access_logs enabled/))
test('WP3: WAF log no longer redacts cookies', () => match([[`${T}/logging.tf`, 'single_header { name = "cookie" }', 'single_header { name = "x-none" }']], /redact authorization and cookie/))
test('WP3: ALB log bucket made public', () => match([[`${T}/logging.tf`, 'block_public_acls       = true', 'block_public_acls       = false']], /block all public access/))
test('WP3: log group without retention', () => match([[`${T}/logging.tf`, 'name              = "/fbeds/${var.environment}/vpc-flow"\n  retention_in_days = local.retention.flow', 'name              = "/fbeds/${var.environment}/vpc-flow"']], /no explicit retention/))
test('WP3: world-open security group rule', () => match([[`${T}/network.tf`, 'prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id', 'cidr_ipv4 = "0.0.0.0/0"\n  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id']], /world-open/))
test('WP3: API path cached at the edge', () => match([[`${T}/edge.tf`, /(path_pattern\s*=\s*"\/api\/v1\/\*"[\s\S]*?cache_policy_id\s*=\s*data\.aws_cloudfront_cache_policy\.)disabled/, '$1optimized']], /must be "disabled"/))
test('WP3: default behavior cached', () => match([[`${T}/edge.tf`, /(default_cache_behavior\s*\{[\s\S]*?cache_policy_id\s*=\s*data\.aws_cloudfront_cache_policy\.)disabled/, '$1optimized']], /\(default\).*must be "disabled"/))
test('WP3: the static path made mutable', () => match([[`${T}/edge.tf`, /(path_pattern\s*=\s*"\/_next\/static\/\*"[\s\S]*?allowed_methods\s*=\s*\[)"GET"/, '$1"POST", "GET"']], /must not allow mutating methods/))
test('WP3: HTTP allowed at the edge', () => match([[`${T}/edge.tf`, /viewer_protocol_policy(\s*)=\s*"redirect-to-https"/, 'viewer_protocol_policy$1= "allow-all"']], /redirect HTTP to HTTPS/))
test('WP3: plaintext origin', () => match([[`${T}/edge.tf`, /origin_protocol_policy(\s*)=\s*"https-only"/, 'origin_protocol_policy$1= "http-only"']], /HTTPS only/))
test('WP3: weak viewer TLS', () => match([[`${T}/edge.tf`, 'TLSv1.2_2021', 'TLSv1']], /TLSv1\.2_2021/))
test('WP3: distribution without a web ACL', () => match([[`${T}/edge.tf`, 'web_acl_id      = aws_wafv2_web_acl.edge[0].arn', '']], /web ACL/))
test('WP3: origin header not required by the ALB', () => match([[`${T}/alb.tf`, 'http_header_name = "X-Origin-Verify"', 'http_header_name = "X-Other"']], /X-Origin-Verify/))
test('WP3: ALB not limited to the CloudFront prefix list', () => match([[`${T}/network.tf`, 'prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id', 'cidr_ipv4 = "10.0.0.0/8"']], /CloudFront prefix list/))
test('WP3: production release guard removed', () => match([[`${T}/alb.tf`, 'var.environment != "production" || var.cloudfront_enabled || trimspace(var.production_edge_exception_ref) != ""', 'true']], /production release guard/))
test('WP3: CI deploy role may run the migration task again', () => match([[`${T}/iam.tf`, 'actions   = ["ecr:DescribeImages"]', 'actions   = ["ecr:DescribeImages", "ecs:RunTask"]']], /must not run tasks/))
test('WP3: PassRole unconstrained', () => match([[`${T}/iam.tf`, 'values   = ["ecs-tasks.amazonaws.com"]', 'values   = ["*"]'], [`${T}/iam.tf`, 'variable = "iam:PassedToService"', 'variable = "iam:Other"']], /PassRole must be constrained/))
test('WP3: API origin baked into the image again', () => match([['Dockerfile.web', 'ARG PACKAGE', 'ARG PACKAGE\nARG API_INTERNAL_URL']], /API_INTERNAL_URL would tie an image/))
test('WP3: a build-time rewrite returns', () => match([['apps/agent/next.config.mjs', 'const nextConfig = {', 'const nextConfig = {\n  async rewrites() { return [] },']], /build-time rewrite/))
test('WP3: portal proxy stops using the resolver', () => match([['apps/supplier/proxy.ts', 'resolveApiDestination', 'somethingElse']], /resolve the API origin per request/))
test('WP3: checkov skip without a reason', () => match([[`${T}/.checkov.yaml`, '  - CKV2_AWS_19   # the EIPs are attached to NAT gateways', '  - CKV2_AWS_19']], /has no reason/))
test('WP3: checkov skip missing from the register', () => match([[`${T}/.checkov.yaml`, '  - CKV2_AWS_19   # the EIPs are attached to NAT gateways', '  - CKV2_AWS_19   # the EIPs are attached to NAT gateways\n  - CKV_AWS_999   # a brand new unregistered exception with a reason']], /CKV_AWS_999 is not in/))
test('WP3: state backend without encryption', () => match([[`${T}/versions.tf`, 'encrypt = true', 'encrypt = false']], /encrypt = true/))
