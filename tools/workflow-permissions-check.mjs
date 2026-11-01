// Least-privilege guard for GitHub Actions workflows: every workflow must declare a top-level `permissions:` block (otherwise the
// repository default token scope applies), never grant `write-all`, and never use the privileged `pull_request_target` trigger.
// Supply chain: third-party actions are pinned to a full commit SHA (a moved tag cannot change what runs) and runners to a fixed
// image (ubuntu-24.04, not ubuntu-latest). Local `./` actions are exempt; Dependabot (github-actions ecosystem) bumps the SHAs.
// Job and service container images carry an @sha256 digest; bump those by hand (Dependabot does not track workflow images).
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
  for (const [, image] of text.matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) problems.push(`${name}: container image ${image} is not pinned to a digest`)
  }
  if (/^\s*runs-on:\s*['"]?[\w-]*-latest\b/m.test(text)) problems.push(`${name}: runs-on uses a floating -latest runner image`)
  // A hung job otherwise runs for the 6-hour default, holding an environment lock and burning minutes. Every job declares an explicit limit.
  const jobs = text.split(/^jobs:\s*$/m)[1]
  if (jobs) {
    for (const block of jobs.split(/^(?=  [A-Za-z0-9_-]+:\s*$)/m)) {
      const id = /^  ([A-Za-z0-9_-]+):\s*$/m.exec(block)?.[1]
      if (id && !/^ {4}timeout-minutes:\s*\d+\s*$/m.test(block) && !/^ {4}uses:/m.test(block)) problems.push(`${name}: job ${id} has no timeout-minutes`)
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = new URL('../.github/workflows/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  const problems = files.flatMap((f) => check(f, readFileSync(new URL(f, dir), 'utf8')))
  if (problems.length) { console.error(`Workflow permission check failed:\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log(`Workflow permission check: ${files.length} workflows declare least-privilege permissions, pin actions, runners and images, and set job timeouts.`)
}
