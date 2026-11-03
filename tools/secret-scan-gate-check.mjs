// The gitleaks job is the pull-request gate. This check fails when that job stops covering a custom rule or stops running on every pull request.
// It does not scan secrets itself; security.yml's self-test does, against values built at runtime.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_RULES = [
  'fbeds-database-url-credentials',
  'fbeds-neon-api-key',
  'fbeds-aws-secret-access-key',
  'fbeds-aws-session-token',
  'fbeds-jwt-signing-secret',
  'fbeds-supplier-credential',
  'fbeds-authorization-header-literal',
]

export function customRuleIds(toml) {
  return [...toml.matchAll(/^id = "(fbeds-[a-z0-9-]+)"/gm)].map((match) => match[1])
}

export function problems(toml, workflow) {
  const ids = customRuleIds(toml)
  const found = []
  for (const id of REQUIRED_RULES) {
    if (!ids.includes(id)) found.push(`.gitleaks.toml is missing required rule ${id}`)
    if (!workflow.includes(id)) found.push(`security.yml self-test does not require ${id}`)
  }
  for (const id of ids) {
    if (!workflow.includes(id)) found.push(`security.yml self-test does not require custom rule ${id}`)
  }
  if (/found["']?\s*-lt\s+\d+/.test(workflow)) found.push('security.yml still accepts a partial custom-rule self-test (found -lt N)')
  const onBlock = workflow.split(/\npermissions:|\nconcurrency:|\njobs:/)[0]
  if (!/\bpull_request:\s*(?:\n|$)/.test(onBlock)) found.push('security.yml must run on every pull request')
  if (/\bpull_request:\s*\n\s+paths(?:-ignore)?:/.test(onBlock)) found.push('security.yml pull_request trigger must not be path-filtered')
  if (!workflow.includes('name: Secret scan (gitleaks)')) found.push('security.yml is missing the Secret scan job')
  return [...new Set(found)]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const found = problems(readFileSync(join(root, '.gitleaks.toml'), 'utf8'), readFileSync(join(root, '.github/workflows/security.yml'), 'utf8'))
  if (found.length) {
    console.error(`Secret scan gate check failed:\n- ${found.join('\n- ')}`)
    process.exit(1)
  }
  console.log(`Secret scan gate: pull requests run gitleaks, and the self-test requires all ${REQUIRED_RULES.length} custom rules.`)
}
