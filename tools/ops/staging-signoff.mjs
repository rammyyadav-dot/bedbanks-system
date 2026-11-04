// Exit gate for staging acceptance (ADR 0112). Fails closed: four roles, one deployed SHA, exact statement.
// This file does not grant a signature. A missing record leaves the gate open.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROLES = ['engineering', 'operations', 'security', 'product']
export const STATEMENT = 'I accept the staging evidence for this SHA.'
const DENY = /^(cursor|agent|cloud agent|unknown|n\/a|na|tbd|todo)$/i

export function evaluateSignoff(doc, expectedSha) {
  const problems = []
  if (!doc || typeof doc !== 'object') return { status: 'OPEN', problems: ['sign-off record missing'] }
  if (doc.sha !== expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha ?? '')) problems.push('sha does not match the deployed commit')
  const signatures = Array.isArray(doc.signatures) ? doc.signatures : []
  const seen = new Set()
  for (const signature of signatures) {
    if (!ROLES.includes(signature.role)) problems.push(`unknown role ${signature.role}`)
    else if (seen.has(signature.role)) problems.push(`duplicate role ${signature.role}`)
    else seen.add(signature.role)
    const name = typeof signature.name === 'string' ? signature.name.trim() : ''
    if (name.length < 2 || DENY.test(name)) problems.push(`role ${signature.role ?? '?'} has no accountable name`)
    if (Number.isNaN(Date.parse(signature.signedAt))) problems.push(`role ${signature.role ?? '?'} has no signedAt`)
    if (signature.statement !== STATEMENT) problems.push(`role ${signature.role ?? '?'} statement does not match`)
  }
  for (const role of ROLES) if (!seen.has(role)) problems.push(`missing ${role}`)
  return { status: problems.length === 0 ? 'SIGNED' : 'OPEN', problems }
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function main() {
  const sha = arg('--sha')
  const file = arg('--file') ?? 'docs/ops/staging-acceptance-signoff.json'
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  const result = evaluateSignoff(doc, sha)
  console.log(JSON.stringify({ gate: 'staging-acceptance', ...result }))
  process.exit(result.status === 'SIGNED' ? 0 : 2)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
