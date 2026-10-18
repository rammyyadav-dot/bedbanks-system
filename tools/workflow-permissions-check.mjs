// Least-privilege guard for GitHub Actions workflows: every workflow must declare a top-level `permissions:` block (otherwise the
// repository default token scope applies), never grant `write-all`, and never use the privileged `pull_request_target` trigger.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function check(name, text) {
  const problems = []
  if (!/^permissions:/m.test(text)) problems.push(`${name}: no top-level permissions block (token scope would fall back to the repository default)`)
  if (/^\s*permissions:\s*write-all\b/m.test(text)) problems.push(`${name}: permissions: write-all`)
  if (/^\s*pull_request_target\s*:|\bon:\s*\[?[^\n]*pull_request_target/m.test(text)) problems.push(`${name}: uses pull_request_target`)
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = new URL('../.github/workflows/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  const problems = files.flatMap((f) => check(f, readFileSync(new URL(f, dir), 'utf8')))
  if (problems.length) { console.error(`Workflow permission check failed:\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log(`Workflow permission check: ${files.length} workflows declare least-privilege permissions.`)
}
