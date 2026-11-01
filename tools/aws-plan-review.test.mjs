import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MANDATORY_TAGS, reviewPlan } from './aws-plan-review.mjs'

const tags = Object.fromEntries(MANDATORY_TAGS.map((t) => [t, 'x']))
const rc = (type, after, actions = ['create'], extra = {}) => ({ address: `${type}.t`, type, change: { actions, after: { tags_all: tags, ...after }, ...extra } })
const plan = (resource_changes, env = 'staging', extra = {}) => ({ variables: { environment: { value: env }, region: { value: 'ap-south-1' } }, resource_changes, ...extra })
const failing = (p, re) => assert.match(reviewPlan(p).fail.join('\n'), re)
const clean = (p) => assert.deepEqual(reviewPlan(p).fail, [])

test('a safe staging plan has no blocking findings', () => clean(plan([
  rc('aws_db_instance', { publicly_accessible: false, storage_encrypted: true, multi_az: false }),
  rc('aws_elasticache_replication_group', { transit_encryption_enabled: true, at_rest_encryption_enabled: true }, ['create'], { after_sensitive: { auth_token: true } }),
  rc('aws_vpc_security_group_ingress_rule', { cidr_ipv4: '203.0.113.0/24', from_port: 443, to_port: 443 }),
  rc('aws_ecs_service', { network_configuration: [{ assign_public_ip: false }] }),
])))
test('wrong region', () => failing(plan([], 'staging', { variables: { environment: { value: 'staging' }, region: { value: 'eu-central-1' } } }), /expected "ap-south-1"/))
test('unknown environment', () => failing(plan([], 'dev'), /staging or production/))
test('public RDS / unencrypted RDS', () => { failing(plan([rc('aws_db_instance', { publicly_accessible: true, storage_encrypted: true })]), /publicly accessible/); failing(plan([rc('aws_db_instance', { publicly_accessible: false, storage_encrypted: false })]), /not encrypted/) })
test('production RDS must be Multi-AZ with deletion protection', () => failing(plan([rc('aws_db_instance', { publicly_accessible: false, storage_encrypted: true, multi_az: false, deletion_protection: false })], 'production'), /single-AZ/))
test('replacing or destroying stateful resources', () => {
  failing(plan([rc('aws_db_instance', {}, ['delete', 'create'])]), /REPLACE of a stateful/)
  failing(plan([rc('aws_kms_key', {}, ['delete'])]), /DESTROY of a stateful/)
})
test('Redis without TLS or without AUTH', () => {
  failing(plan([rc('aws_elasticache_replication_group', { transit_encryption_enabled: false, at_rest_encryption_enabled: true })]), /not encrypted/)
  failing(plan([rc('aws_elasticache_replication_group', { transit_encryption_enabled: true, at_rest_encryption_enabled: true })]), /AUTH token missing/)
})
test('world-open ingress: failure in staging, review in production', () => {
  const r = rc('aws_vpc_security_group_ingress_rule', { cidr_ipv4: '0.0.0.0/0', from_port: 443, to_port: 443 })
  failing(plan([r]), /world-open ingress in STAGING/)
  const p = reviewPlan(plan([r], 'production'))
  assert.equal(p.fail.filter((f) => /world-open/.test(f)).length, 0)
  assert.match(p.review.join('\n'), /world-open ingress/)
})
test('public task IPs', () => failing(plan([rc('aws_ecs_service', { network_configuration: [{ assign_public_ip: true }] })]), /public IPs/))
test('wildcard IAM allow fails; Deny wildcard and the KMS root statement pass', () => {
  const doc = (st) => JSON.stringify({ Version: '2012-10-17', Statement: st })
  failing(plan([rc('aws_iam_role_policy', { policy: doc([{ Effect: 'Allow', Action: ['ecs:*'], Resource: '*' }]) })]), /wildcard action/)
  clean(plan([rc('aws_s3_bucket_policy', { policy: doc([{ Effect: 'Deny', Action: 's3:*', Resource: '*' }]) })]))
  clean(plan([rc('aws_kms_key', { policy: doc([{ Sid: 'AccountRootAndIam', Effect: 'Allow', Action: 'kms:*', Resource: '*' }]) })]))
  failing(plan([rc('aws_kms_key', { policy: doc([{ Sid: 'Other', Effect: 'Allow', Action: 'kms:*', Resource: '*' }]) })]), /wildcard action/)
})
test('GitHub OIDC trust with a wildcard subject', () => failing(plan([rc('aws_iam_role', { assume_role_policy: JSON.stringify({ Statement: [{ Principal: { Federated: 'arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com' }, Condition: { StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:o/r:*' } } }] }) })]), /OIDC trust/))
test('missing mandatory tag', () => {
  const t = { ...tags }; delete t.CostCenter
  failing(plan([{ address: 'aws_s3_bucket.t', type: 'aws_s3_bucket', change: { actions: ['create'], after: { tags_all: t } } }]), /CostCenter/)
})
test('secret-looking outputs must be sensitive', () => {
  failing(plan([], 'staging', { output_changes: { redis_password: { after_sensitive: false } } }), /secret material/)
  clean(plan([], 'staging', { output_changes: { redis_password: { after_sensitive: true }, secret_arns: { after_sensitive: false } } }))
})
test('DNS records, budgets and CloudFront are surfaced for a human', () => {
  const r = reviewPlan(plan([rc('aws_route53_record', { type: 'A', name: 'agent.staging.example.com' }), rc('aws_budgets_budget', { limit_amount: '100', limit_unit: 'USD' }), rc('aws_cloudfront_distribution', { aliases: ['agent.example.com'] })]))
  assert.equal(r.fail.length, 0)
  const text = r.review.join('\n')
  assert.match(text, /DNS record/); assert.match(text, /budget limit 100/); assert.match(text, /CloudFront distribution/)
})
test('no-op and read-only changes are ignored', () => clean(plan([rc('aws_db_instance', { publicly_accessible: true }, ['no-op'])])))
