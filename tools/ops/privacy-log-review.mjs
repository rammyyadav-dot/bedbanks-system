// Engineering privacy review of log call sites. Not legal approval.
// Flags logger or console calls whose arguments mention credential or guest fields.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['apps', 'packages']
const SKIP = new Set(['node_modules', 'dist', '.next', 'coverage'])
const CALL = /(logger|console)\.(log|debug|info|warn|error|verbose)\(/
// A finding is a log that places a credential or guest field into the message, not a sentence that names the word.
const SENSITIVE = /(password|authorization|set-cookie|cookie|guestEmail|guestName|rawBody|passport|creditCard)\s*[:=]\s*(\$\{|[A-Za-z_(])|\$\{[^}]*(password|authorization|cookie|guestEmail|guestName|rawBody)/i
const ALLOW = /redact|never log|without|must not|do not log|not logged|not printed|never commit|omit/i

export function reviewSource(files) {
  const findings = []
  for (const [file, text] of files) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!CALL.test(line) || !SENSITIVE.test(line) || ALLOW.test(line)) continue
      if (/spec\.|e2e-spec|__tests__/.test(file)) continue
      findings.push({ file, line: i + 1, text: line.trim().slice(0, 180) })
    }
  }
  return findings
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push([path, readFileSync(path, 'utf8')])
  }
}

export function reviewTree(root) {
  const files = []
  for (const dir of ROOTS) walk(join(root, dir), files)
  const findings = reviewSource(files)
  const legal = readFileSync(join(root, 'apps/website/lib/legal-status.ts'), 'utf8')
  const privacyPolicyApproved = /export const privacyPolicyApproved = true/.test(legal)
  return {
    review: 'privacy-engineering',
    legalApproval: privacyPolicyApproved ? 'CODE_CLAIMS_APPROVED' : 'BLOCKED',
    findings,
  }
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const result = reviewTree(root)
  console.log(JSON.stringify(result))
  if (result.legalApproval !== 'BLOCKED' || result.findings.length) process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
