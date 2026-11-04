// Tabletop for docs/runbooks/incident-response.md. Reads the runbook and checks the decisions the drill must reach.
// It does not page anyone, call AWS, or touch a database.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SCENARIOS = [
  {
    id: 'cross-tenant',
    severity: 1,
    runbook: /Suspected cross-tenant access/,
    actions: ['Suspend the affected route', 'Notify every affected tenant owner'],
  },
  {
    id: 'credential-exposure',
    severity: 1,
    runbook: /Credential or token exposure/,
    actions: ['Rotate per', 'Revoke active sessions'],
  },
  {
    id: 'supplier-outage',
    severity: 2,
    runbook: /Supplier outage or bad supplier data/,
    actions: ['do not enable a fallback', 'stale or zero-priced'],
  },
  {
    id: 'ledger',
    severity: 1,
    runbook: /Booking, wallet or ledger inconsistency/,
    actions: ['never by editing ledger', 'original idempotency key'],
  },
  {
    id: 'data-loss',
    severity: 1,
    runbook: /Data loss or corruption/,
    actions: ['NEW instance', 'Never restore over the live instance'],
  },
  {
    id: 'bad-release',
    severity: 2,
    runbook: /Bad release/,
    actions: ['previous code cannot run', 'stop and escalate'],
  },
]

export function reviewIncidentRunbook(markdown) {
  const problems = []
  if (!/Sev \| Meaning/.test(markdown) && !/\| Sev \| Meaning \|/.test(markdown)) problems.push('severity table missing')
  if (!/## First 15 minutes/.test(markdown)) problems.push('first 15 minutes missing')
  if (!/When unsure between two severities, take the higher one/.test(markdown)) problems.push('severity tie-break missing')
  for (const scenario of SCENARIOS) {
    if (!scenario.runbook.test(markdown)) problems.push(`${scenario.id}: playbook missing`)
    for (const action of scenario.actions) if (!markdown.includes(action)) problems.push(`${scenario.id}: missing "${action}"`)
  }
  return { pass: problems.length === 0, problems, scenarios: SCENARIOS.map(({ id, severity }) => ({ id, severity })) }
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const markdown = readFileSync(`${root}/docs/runbooks/incident-response.md`, 'utf8')
  const result = reviewIncidentRunbook(markdown)
  console.log(JSON.stringify({ drill: 'incident-tabletop', ...result }))
  if (!result.pass) process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
