// Fails when a production dependency has a high or critical advisory that is not accepted in security/audit-allowlist.json.
// Pure decision logic is exported so it can be tested without the network; the CLI wrapper runs `pnpm audit --prod --json`.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BLOCKING = new Set(['high', 'critical'])

export function evaluate(advisories, allowlist, today = new Date().toISOString().slice(0, 10)) {
  const accepted = new Map((allowlist.accepted ?? []).map((entry) => [entry.advisory, entry]))
  const problems = []
  for (const entry of accepted.values()) {
    if (!entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '')) problems.push(`allowlist entry ${entry.advisory} needs a reason and an expires date`)
    else if (entry.expires < today) problems.push(`allowlist entry ${entry.advisory} (${entry.module}) expired ${entry.expires}: fix it or renew with a new review`)
  }
  for (const advisory of Object.values(advisories)) {
    if (!BLOCKING.has(advisory.severity)) continue
    if (!accepted.has(advisory.github_advisory_id)) problems.push(`${advisory.severity} ${advisory.module_name} ${advisory.github_advisory_id}: ${advisory.title} (patched: ${advisory.patched_versions})`)
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowlist = JSON.parse(readFileSync(new URL('../security/audit-allowlist.json', import.meta.url), 'utf8'))
  const run = spawnSync('pnpm', ['audit', '--prod', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let report
  try { report = JSON.parse(run.stdout) } catch { console.error(`pnpm audit produced no JSON (exit ${run.status}): ${run.stderr.slice(0, 500)}`); process.exit(2) }
  if (!report.advisories) { console.error('pnpm audit JSON has no advisories field; refusing to pass'); process.exit(2) }
  const problems = evaluate(report.advisories, allowlist)
  if (problems.length) { console.error(`Dependency audit failed:\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log(`Dependency audit clean: no unaccepted high/critical production advisories (${Object.keys(report.advisories).length} total).`)
}
