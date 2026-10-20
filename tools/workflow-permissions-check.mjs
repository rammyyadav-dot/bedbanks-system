// Least-privilege guard for GitHub Actions workflows: every workflow must declare a top-level `permissions:` block (otherwise the
// repository default token scope applies), never grant `write-all`, and never use the privileged `pull_request_target` trigger.
// Supply chain: third-party actions are pinned to a full commit SHA (a moved tag cannot change what runs) and runners to a fixed
// image (ubuntu-24.04, not ubuntu-latest). Local `./` actions are exempt; Dependabot (github-actions ecosystem) bumps the SHAs.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function check(name, text) {
  const problems = []
  if (!/^permissions:/m.test(text)) problems.push(`${name}: no top-level permissions block (token scope would fall back to the repository default)`)
  if (/^\s*permissions:\s*write-all\b/m.test(text)) problems.push(`${name}: permissions: write-all`)
  if (/^\s*pull_request_target\s*:|\bon:\s*\[?[^\n]*pull_request_target/m.test(text)) problems.push(`${name}: uses pull_request_target`)
  for (const [, ref] of text.matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/gm)) {
    if (!ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref)) problems.push(`${name}: ${ref} is not pinned to a commit SHA`)
  }
  if (/^\s*runs-on:\s*['"]?[\w-]*-latest\b/m.test(text)) problems.push(`${name}: runs-on uses a floating -latest runner image`)
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = new URL('../.github/workflows/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  const problems = files.flatMap((f) => check(f, readFileSync(new URL(f, dir), 'utf8')))
  if (problems.length) { console.error(`Workflow permission check failed:\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log(`Workflow permission check: ${files.length} workflows declare least-privilege permissions and pin actions and runners.`)
}
