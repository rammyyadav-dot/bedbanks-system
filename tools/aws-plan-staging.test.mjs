// Tests for infra/aws/plan-staging.sh with stub `aws` and `terraform` binaries: no network, no AWS, no real Terraform.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = 'infra/aws/plan-staging.sh'
const GOOD_VARS = 'region = "ap-south-1"\nenvironment = "staging"\ndomain_name = "fbeds.com"\nhosted_zone_id = "Z0123456789ABCDEFGHIJ"\npublic_ingress_cidrs = ["198.51.100.0/24"]\n'
const safePlan = { variables: { environment: { value: 'staging' }, region: { value: 'ap-south-1' } }, resource_changes: [{ address: 'aws_db_instance.this', type: 'aws_db_instance', change: { actions: ['create'], after: { publicly_accessible: false, storage_encrypted: true } } }] }
const unsafePlan = { ...safePlan, resource_changes: [{ address: 'aws_db_instance.this', type: 'aws_db_instance', change: { actions: ['create'], after: { publicly_accessible: true, storage_encrypted: true } } }] }

function setup({ account = '111111111111', plan = safePlan, vars = GOOD_VARS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'planstg-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const log = join(dir, 'calls.log')
  writeFileSync(join(bin, 'aws'), `#!/bin/sh\necho "aws $*" >> "${log}"\necho '{"Account":"${account}","Arn":"arn:aws:iam::${account}:user/test"}'\n`)
  writeFileSync(join(bin, 'terraform'), `#!/bin/sh
echo "terraform $*" >> "${log}"
case "$*" in
  *"show -json"*) cat "${join(dir, 'plan.json')}" ;;
  *"show -no-color"*) echo "plan text" ;;
  *" plan "*) exit 2 ;;
esac
exit 0
`)
  chmodSync(join(bin, 'aws'), 0o755); chmodSync(join(bin, 'terraform'), 0o755)
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
  const tfvars = join(dir, 'staging.tfvars'); writeFileSync(tfvars, vars)
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, EXPECT_ACCOUNT_ID: '111111111111', TF_STATE_BUCKET: 'b', TF_LOCK_TABLE: 't', TFVARS: tfvars, OUT_DIR: join(dir, 'out') }
  return { dir, log, env, run: (over = {}) => spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...env, ...over } }) }
}
const calls = (s) => (existsSync(s.log) ? readFileSync(s.log, 'utf8') : '')

test('refuses to run without its required environment', () => {
  const s = setup(); const r = s.run({ EXPECT_ACCOUNT_ID: '' })
  assert.equal(r.status, 2); assert.match(r.stderr, /EXPECT_ACCOUNT_ID is not set/); assert.equal(calls(s), '')
})
test('refuses another region', () => { const s = setup(); const r = s.run({ AWS_REGION: 'eu-central-1' }); assert.equal(r.status, 2); assert.match(r.stderr, /ap-south-1 only/) })
test('refuses a production, placeholder, open or DNS-creating variable file before touching AWS', () => {
  const bad = {
    'environment = "production"': GOOD_VARS.replace('"staging"', '"production"'),
    'placeholders': GOOD_VARS.replace('Z0123456789ABCDEFGHIJ', 'ZXXXXXXXXXXXXX'),
    'documentation CIDR': GOOD_VARS.replace('198.51.100.0/24', '203.0.113.0/24'),
    '0.0.0.0/0': GOOD_VARS.replace('198.51.100.0/24', '0.0.0.0/0'),
    'missing ingress': GOOD_VARS.replace(/public_ingress_cidrs.*\n/, ''),
    'create_portal_records': GOOD_VARS + 'create_portal_records = true\n',
    'wrong region': GOOD_VARS.replace('ap-south-1', 'us-east-1'),
  }
  for (const [name, vars] of Object.entries(bad)) {
    const s = setup({ vars }); const r = s.run()
    assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`)
    assert.equal(calls(s), '', `${name}: nothing may be called before the variable file passes`)
  }
})
test('refuses a template file', () => {
  const s = setup(); const t = join(s.dir, 'staging.tfvars.example'); writeFileSync(t, GOOD_VARS)
  assert.match(s.run({ TFVARS: t }).stderr, /template/)
})
test('stops when the credentials belong to another account, before any Terraform call', () => {
  const s = setup({ account: '999999999999' }); const r = s.run()
  assert.equal(r.status, 2); assert.match(r.stderr, /credentials belong to account 999999999999/); assert.doesNotMatch(calls(s), /terraform/)
})
test('happy path: init, validate, test, plan, review; NEVER apply or destroy; private output directory', () => {
  const s = setup(); const r = s.run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const c = calls(s)
  for (const step of ['init', 'fmt -check', 'validate', ' test', ' plan ', 'show -json']) assert.ok(c.includes(step), `missing step ${step}\n${c}`)
  assert.doesNotMatch(c, /\b(apply|destroy|import|state rm|taint|force-unlock)\b/)
  assert.match(c, /backend-config=encrypt=true/)
  assert.equal(statSync(join(s.dir, 'out')).mode & 0o777, 0o700)
  assert.match(r.stdout, /never applies/)
})
test('a failing mechanical review fails the script (exit 1) and says do not apply', () => {
  const s = setup({ plan: unsafePlan }); const r = s.run()
  assert.equal(r.status, 1); assert.match(r.stderr, /publicly accessible/); assert.match(r.stdout, /Do NOT apply/)
})
test('the script text contains no apply/destroy invocation', () => {
  const text = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(text.replace(/"[^"\n]*"/g, '""'), /terraform[^\n]*\b(apply|destroy)\b|\btf (apply|destroy)\b/)
})
