import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

function buildHash(packageName, env) {
  const output = execFileSync('pnpm', ['exec', 'turbo', 'run', 'build', `--filter=${packageName}`, '--dry=json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  const task = JSON.parse(output).tasks.find((entry) => entry.taskId === `${packageName}#build`)
  assert.ok(task?.hash, `Missing build hash for ${packageName}`)
  return task.hash
}

const cases = [
  ['@bedbanks/website', 'NEXT_PUBLIC_SITE_URL'],
  ['@bedbanks/website', 'NEXT_PUBLIC_AGENT_URL'],
  ['@bedbanks/website', 'NEXT_PUBLIC_ADMIN_URL'],
  ['@bedbanks/website', 'NEXT_PUBLIC_SUPPLIER_URL'],
  ['@bedbanks/website', 'NEXT_PUBLIC_CONTACT_EMAIL'],
  ['@bedbanks/agent-portal', 'API_INTERNAL_URL'],
  ['@bedbanks/admin-console', 'AUTH_API_ORIGIN'],
  ['@bedbanks/supplier-portal', 'SUPPLIER_ORIGIN'],
]

for (const [packageName, key] of cases) {
  const first = buildHash(packageName, { [key]: 'https://first.example/api/v1' })
  const second = buildHash(packageName, { [key]: 'https://second.example/api/v1' })
  assert.notEqual(first, second, `${key} must invalidate ${packageName}'s build cache`)
  console.log(`PASS: ${packageName} build hash changes with ${key}`)
}
