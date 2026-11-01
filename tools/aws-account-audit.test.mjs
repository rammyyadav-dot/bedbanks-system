// Decision-logic tests for infra/aws/audit/account-audit.sh with a stub `aws` CLI (no AWS access). The script only reads; the stub records calls so we can prove it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ok = {
  'sts get-caller-identity': { Account: '111111111111', Arn: 'arn:aws:iam::111111111111:role/audit' },
  'organizations describe-organization': { Organization: { Id: 'o-abc', FeatureSet: 'ALL' } },
  'sso-admin list-instances': { Instances: [{ InstanceArn: 'arn:x' }] },
  'iam get-account-summary': { SummaryMap: { AccountMFAEnabled: 1, AccountAccessKeysPresent: 0, Users: 0 } },
  'cloudtrail describe-trails': { trailList: [{ Name: 'main', IsMultiRegionTrail: true, LogFileValidationEnabled: true, KmsKeyId: 'arn:kms', IsOrganizationTrail: true, S3BucketName: 'trail-bkt' }] },
  'cloudtrail get-trail-status': { IsLogging: true },
  'get-bucket-versioning': { Status: 'Enabled' },
  'get-bucket-encryption': { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }] } },
  'get-public-access-block': { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } },
  'dynamodb describe-table': { Table: { KeySchema: [{ AttributeName: 'LockID', KeyType: 'HASH' }] } },
  'iam list-open-id-connect-providers': { OpenIDConnectProviderList: [{ Arn: 'arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com' }] },
  'iam list-roles': { Roles: [{ RoleName: 'fbeds-staging-github-deploy' }] },
  'iam get-role': { Role: { AssumeRolePolicyDocument: { Statement: [{ Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:o/r:environment:staging' } } }] } } },
  'budgets describe-budgets': { Budgets: [{ BudgetName: 'fbeds-staging-monthly' }] },
}
function run(overrides = {}, args = ['ap-south-1', 'state-bkt', 'lock-tbl']) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-')); const bin = join(dir, 'bin'); mkdirSync(bin)
  const table = { ...ok, ...overrides }
  writeFileSync(join(dir, 'table.json'), JSON.stringify(table))
  writeFileSync(join(bin, 'aws'), `#!/usr/bin/env node
const t = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(dir, 'table.json'))}, 'utf8'))
const a = process.argv.slice(2).filter((x) => !['--region', 'ap-south-1', '--output', 'json'].includes(x))
require('fs').appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, a.join(' ') + '\\n')
const key = Object.keys(t).find((k) => a.join(' ').startsWith(k) || (!k.includes(' ') && a.includes(k)))
const v = key ? t[key] : undefined
if (v === undefined) { console.error('AccessDenied'); process.exit(255) }
if (typeof v === 'string' && v.startsWith('ERR:')) { console.error(v.slice(4)); process.exit(254) }
console.log(JSON.stringify(v))
`)
  chmodSync(join(bin, 'aws'), 0o755)
  const r = spawnSync('bash', ['infra/aws/audit/account-audit.sh', ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } })
  let calls = ''; try { calls = readFileSync(join(dir, 'calls.log'), 'utf8') } catch {}
  return { ...r, calls, lines: r.stdout.split('\n').filter(Boolean) }
}
const status = (r, name) => r.lines.find((l) => l.includes(name))?.trim().split(/\s+/)[0]

test('a healthy account yields PASS for every control and no FAIL', () => {
  const r = run(); assert.equal(r.status, 0, r.stderr)
  for (const c of ['organizations', 'identity-center', 'root-mfa', 'root-access-keys', 'cloudtrail:main', 'tfstate-versioning', 'tfstate-encryption', 'tfstate-public-block', 'tfstate-lock-table', 'github-oidc-provider', 'oidc-trust:fbeds-staging-github-deploy']) assert.equal(status(r, c), 'PASS', `${c}\n${r.stdout}`)
  assert.ok(!r.lines.some((l) => l.startsWith('FAIL')), r.stdout)
})
test('every unhealthy condition is reported as FAIL, never PASS', () => {
  const bad = run({
    'organizations describe-organization': 'ERR:An error occurred (AWSOrganizationsNotInUseException)',
    'sso-admin list-instances': { Instances: [] },
    'iam get-account-summary': { SummaryMap: { AccountMFAEnabled: 0, AccountAccessKeysPresent: 1, Users: 4 } },
    'cloudtrail describe-trails': { trailList: [{ Name: 'weak', IsMultiRegionTrail: false, LogFileValidationEnabled: false, KmsKeyId: null, IsOrganizationTrail: false, S3BucketName: 'trail-bkt' }] },
    'get-bucket-versioning': { Status: 'Suspended' },
    'get-bucket-encryption': 'ERR:ServerSideEncryptionConfigurationNotFoundError',
    'get-public-access-block': { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: false, BlockPublicPolicy: true, RestrictPublicBuckets: true } },
    'dynamodb describe-table': { Table: { KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] } },
    'iam get-role': { Role: { AssumeRolePolicyDocument: { Statement: [{ Condition: { StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:o/r:*' } } }] } } },
  })
  for (const c of ['organizations', 'identity-center', 'root-mfa', 'root-access-keys', 'cloudtrail:weak', 'tfstate-versioning', 'tfstate-encryption', 'tfstate-public-block', 'tfstate-lock-table', 'oidc-trust:fbeds-staging-github-deploy']) assert.equal(status(bad, c), 'FAIL', `${c}\n${bad.stdout}`)
})
test('an identity that cannot see a control reports UNKNOWN, which is not a pass', () => {
  const r = run({ 'organizations describe-organization': undefined, 'sso-admin list-instances': undefined, 'budgets describe-budgets': undefined })
  assert.equal(status(r, 'organizations'), 'UNKNOWN'); assert.equal(status(r, 'identity-center'), 'UNKNOWN'); assert.equal(status(r, 'budgets'), 'UNKNOWN')
})
test('read-only: only describe/list/get calls are ever made', () => {
  const r = run()
  for (const line of r.calls.split('\n').filter(Boolean)) assert.match(line, /\b(get-|describe-|list-)[a-z-]+/, `unexpected call: ${line}`)
  assert.doesNotMatch(r.calls, /\b(create|put|delete|update|attach|detach|modify|tag|untag|start|stop|run|invoke)-/)
})
test('requires its arguments and credentials', () => {
  assert.notEqual(run({}, []).status, 0)
  assert.equal(run({ 'sts get-caller-identity': 'ERR:no creds' }).status, 2)
})
