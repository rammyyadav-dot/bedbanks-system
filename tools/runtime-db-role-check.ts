// P0-01 (ADR 0040) architecture guard: runtime processes must be configured with the restricted database login, never the migration owner, and no new database
// client may appear outside the audited list. Static only: it reads repository files and parses user@host/db out of literal URLs. It never prints a password.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkRuntimeUrl, describeDatabaseUrl, forbiddenUserReason } from '../apps/api/src/database/runtime-db-identity'

/** Variables a deployed service reads at runtime. Their literal values must be the restricted logins. */
export const RUNTIME_DB_VARS = ['DATABASE_URL', 'BOOKING_OPS_DATABASE_URL', 'HOLD_EXPIRY_DATABASE_URL', 'TENANT_CONTROL_DATABASE_URL', 'COMPLIANCE_DATABASE_URL'] as const
/** Variables that carry owner or administrator credentials. They belong to release jobs and operators only, never to a service definition. */
export const OWNER_ONLY_VARS = ['MIGRATION_DATABASE_URL', 'PROVISION_DATABASE_URL', 'OWNER_DATABASE_URL', 'DIRECT_URL', 'DATABASE_URL_UNPOOLED'] as const

/** Every place a PrismaClient may be constructed in application source (under apps and packages source, plus apps/api/prisma). Anything else is a violation. */
export const APPROVED_CLIENTS: ReadonlyArray<{ file: string; purpose: string; url: string; runtime: boolean }> = [
  { file: 'apps/api/src/platform-admin/tenant-control.database.ts', purpose: 'Dedicated restricted tenant authoring connection; always identity verified', url: 'TENANT_CONTROL_DATABASE_URL', runtime: true },
  { file: 'apps/api/src/database/certify-tenant-control.cli.ts', purpose: 'test-only: owner fixture provisioning on disposable loopback database', url: 'DATABASE_URL (owner in isolated CI)', runtime: false },
  { file: 'apps/api/src/database/provision-tenant-control-role.cli.ts', purpose: 'operator: provisions the dedicated tenant control role', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/prisma.service.ts', purpose: 'HTTP runtime client (also used for the booking, hold-expiry, ledger-integrity monitor and rate plan lifecycle connections); identity-checked at startup', url: 'DATABASE_URL / BOOKING_OPS_DATABASE_URL / HOLD_EXPIRY_DATABASE_URL / LEDGER_INTEGRITY_DATABASE_URL / RATE_PLAN_OPS_DATABASE_URL', runtime: true },
  { file: 'apps/api/src/database/provision-api-runtime-role.cli.ts', purpose: 'operator: provisions the API login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-booking-ops-role.cli.ts', purpose: 'operator: provisions the booking login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/verify-rate-plan-ops-role.cli.ts', purpose: 'operator: read-only certification of the rate plan lifecycle login, run as that login', url: 'RATE_PLAN_OPS_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-reconciliation-role.cli.ts', purpose: 'operator: provisions the supplier statement reconciliation login (ADR 0070)', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/verify-reconciliation-role.cli.ts', purpose: 'operator: read-only certification run AS the reconciliation login (no owner credential)', url: 'FINANCE_RECONCILIATION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-rate-plan-ops-role.cli.ts', purpose: 'operator: provisions the rate plan lifecycle login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/verify-rate-plan-ops-role.cli.ts', purpose: 'operator: read-only certification run AS the rate plan lifecycle login (no owner credential)', url: 'RATE_PLAN_OPS_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/verify-rate-plan-clone-role.cli.ts', purpose: 'operator: read-only certification run AS the rate plan clone login (no owner credential)', url: 'RATE_PLAN_CLONE_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-rate-plan-clone-role.cli.ts', purpose: 'operator: provisions the rate plan clone login (DRAFT-only insert)', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-hold-expiry-role.cli.ts', purpose: 'operator: provisions the hold-expiry login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/backfill-booking-supplier.cli.ts', purpose: 'operator: dry-run-first historical booking supplier attribution report (ADR 0061 Amendment 1)', url: 'MIGRATION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-preview-fixtures.cli.ts', purpose: 'operator: preview fixtures (refuses non-preview targets)', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/bootstrap-first-admin.cli.ts', purpose: 'operator: first admin bootstrap', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'tools/load/hybrid-search-load.ts', purpose: 'operator: read-only hybrid retrieval load test run AS the strict runtime role (never writes; DATABASE_URL deliberately not read)', url: 'LOADTEST_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/hold-expiry-ops.cli.ts', purpose: 'operator: owner client plus restricted verification client', url: 'PROVISION_DATABASE_URL / HOLD_EXPIRY_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/strict-role-rollout.cli.ts', purpose: 'operator: rollout status (owner) and verify (runtime login)', url: 'PROVISION_DATABASE_URL / API_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/inventory/pool-night-authoring.cli.ts', purpose: 'operator: pool night authoring', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/compliance/compliance-ops.cli.ts', purpose: 'scheduled compliance export/verify AS the restricted compliance login (identity-checked), plus owner-run provisioning of that login (ADR 0067)', url: 'COMPLIANCE_DATABASE_URL / PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/prisma/seed.ts', purpose: 'developer seed (never run in a deployment)', url: 'DATABASE_URL', runtime: false },
]

/**
 * Operator and verification scripts under tools/. They are one-shot processes that open their own client and exit, never part of a deployed service,
 * but an unlisted one is still a violation so a new script cannot quietly start opening pools or using owner credentials.
 */
export const APPROVED_TOOL_CLIENTS: ReadonlyArray<{ file: string; purpose: string }> = [
  { file: 'tools/certify-production-clone.mjs', purpose: 'operator: certifies a production clone (FBEDS_CERT_CLONE_DATABASE_URL, guarded by clone-certification-guard)' },
  { file: 'tools/load/hybrid-search-load.ts', purpose: 'operator: read-only concurrency load test for hybrid hotel retrieval (LOADTEST_DATABASE_URL, strict runtime role, pooled endpoint)' },
  { file: 'tools/hotel-search-smoke.ts', purpose: 'operator: disposable smoke test for hotel search indexes and hybrid retrieval (ADR 0072)' },
  { file: 'tools/admin-ops-verify/inventory-scale.ts', purpose: 'operator: inventory scale check; owner client plus optional runtime-login client' },
  { file: 'tools/admin-ops-verify/seed.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-agent-images.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-agent-mvp.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-bookings.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-credit.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-hotel-journey.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-hotels.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-inventory.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-pool-capacity.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/seed-rate-certification.ts', purpose: 'operator: disposable verification seed' },
  { file: 'tools/admin-ops-verify/verify-rate-plans.cjs', purpose: 'operator: rate plan verification script' },
  { file: 'tools/admin-ops-verify/verify-rate-plans-strict.cjs', purpose: 'operator: strict-role rate plan verification script' },
]

const GUARD_FILE = 'tools/runtime-db-role-check.ts'
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', '.git', 'coverage'])
function walk(dir: string, accept: (path: string) => boolean, found: string[] = []): string[] {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, accept, found)
    else if (accept(path)) found.push(path)
  }
  return found
}

const LOCAL = /^(localhost|127\.0\.0\.1|::1|postgres|db)$/
// `NAME=url`, `NAME: url`, and the Render/compose list form `- key: NAME` followed by `value: url`.
const URL_ASSIGNMENT = (name: string) => new RegExp(`(?<![A-Z_])${name}["']?(?:\\s*[:=]\\s*|\\s*\\n\\s*value:\\s*)["']?(postgres(?:ql)?:\\/\\/[^\\s"'#]+)`, 'g')

/** Violations for one configuration file's text. `disposable` marks CI/test files where a local owner URL is expected. */
export function checkConfigText(file: string, text: string, opts: { disposable: boolean; serviceDefinition: boolean }): string[] {
  const violations: string[] = []
  for (const name of RUNTIME_DB_VARS) {
    for (const match of text.matchAll(URL_ASSIGNMENT(name))) {
      let host = ''
      try { host = describeDatabaseUrl(match[1]).host } catch { violations.push(`${file}: ${name} holds a malformed URL`); continue }
      const verdict = checkRuntimeUrl(match[1])
      if (verdict.ok) continue
      const target = verdict.target
      if (opts.disposable && LOCAL.test(host)) continue // the disposable CI database is owned by its own throwaway superuser
      violations.push(`${file}: ${name} is configured with ${target ? `user "${target.user}"` : 'an invalid URL'} (${verdict.reason}); a runtime service must use the restricted login`)
    }
  }
  if (opts.serviceDefinition) {
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n') // comments may explain the rule
    for (const name of OWNER_ONLY_VARS) {
      if (new RegExp(`(^|[^A-Z_])${name}([^A-Z_]|$)`).test(code)) violations.push(`${file}: ${name} must not appear in a runtime service definition (owner credentials belong to release and operator jobs only)`)
    }
  }
  return violations
}

/**
 * ADR 0067: every `new PrismaService(...)` opens its own connection pool, so runtime code may construct one only in these process-wide holders
 * (Nest singletons that create the client once, lazily). Anything else injects PrismaService or one of these holders instead.
 */
export const APPROVED_POOL_HOLDERS: ReadonlyArray<{ file: string; url: string }> = [
  { file: 'apps/api/src/booking-ops/booking-ops-database.ts', url: 'BOOKING_OPS_DATABASE_URL' },
  { file: 'apps/api/src/agent/hold-expiry-sweeper.service.ts', url: 'HOLD_EXPIRY_DATABASE_URL' },
  { file: 'apps/api/src/admin-operations/ledger-integrity-monitor.service.ts', url: 'LEDGER_INTEGRITY_DATABASE_URL' },
  { file: 'apps/api/src/platform-admin/tenant-control.database.ts', url: 'TENANT_CONTROL_DATABASE_URL' },
  { file: 'apps/api/src/supply/narrow-role-database.ts', url: 'RATE_PLAN_OPS_DATABASE_URL / RATE_PLAN_CLONE_DATABASE_URL / FINANCE_RECONCILIATION_DATABASE_URL' },
]

export function checkClientSource(file: string, text: string): string[] {
  const violations: string[] = []
  if (/new\s+PrismaClient\s*\(|extends\s+PrismaClient\b/.test(text) && !APPROVED_CLIENTS.some((c) => c.file === file) && !APPROVED_TOOL_CLIENTS.some((c) => c.file === file)) violations.push(`${file}: constructs a PrismaClient that is not in the audited client list (tools/runtime-db-role-check.ts). Route it through PrismaService or add it with its purpose, URL source and role.`)
  if (/new\s+PrismaService\s*\(/.test(text) && !APPROVED_POOL_HOLDERS.some((h) => h.file === file) && !APPROVED_TOOL_CLIENTS.some((c) => c.file === file)) violations.push(`${file}: constructs a PrismaService, which opens a new connection pool. Inject PrismaService (or an existing role connection) instead; see ADR 0067.`)
  return violations
}

export function scanRepository(root: string): { violations: string[]; clients: typeof APPROVED_CLIENTS; checked: number } {
  const violations: string[] = []
  let checked = 0
  const rel = (p: string) => relative(root, p).split('\\').join('/')
  // Service definitions and templates.
  const serviceFiles = [join(root, 'render.yaml'), ...walk(root, (p) => /(^|\/)Dockerfile[^/]*$/.test(p) || /docker-compose[^/]*\.ya?ml$/.test(p) || /\.env\.example$/.test(p) || /task-definition[^/]*\.json$/.test(p) || /\.tf$/.test(p), []).filter((p) => !p.includes('/node_modules/'))]
  for (const file of new Set(serviceFiles)) {
    if (!existsSync(file) || !statSync(file).isFile()) continue
    checked += 1
    violations.push(...checkConfigText(rel(file), readFileSync(file, 'utf8'), { disposable: false, serviceDefinition: !/\.env\.example$/.test(file) }))
  }
  // Workflows: local disposable databases may use their owner; a remote database may not be configured with one anywhere.
  for (const file of walk(join(root, '.github/workflows'), (p) => /\.ya?ml$/.test(p))) {
    checked += 1
    violations.push(...checkConfigText(rel(file), readFileSync(file, 'utf8'), { disposable: true, serviceDefinition: false }))
  }
  // Database clients in application source.
  for (const base of ['apps/api/src', 'apps/api/prisma', 'apps/admin', 'apps/agent', 'apps/supplier', 'apps/website', 'packages', 'tools']) {
    for (const file of walk(join(root, base), (p) => /\.(ts|tsx|js|mjs|cjs)$/.test(p) && !/\.(spec|test|e2e-spec)\./.test(p) && !p.includes('/test/') && !p.includes('/migrations/'))) {
      if (rel(file) === GUARD_FILE) continue // this file names the patterns it searches for
      const text = readFileSync(file, 'utf8')
      checked += 1
      violations.push(...checkClientSource(rel(file), text))
      if (base !== 'tools' && !base.startsWith('apps/api') && /from\s+['"]@prisma\/client['"]/.test(text)) violations.push(`${rel(file)}: only the API may import @prisma/client`)
    }
  }
  return { violations, clients: APPROVED_CLIENTS, checked }
}

// A name is never proof of safety (the startup guard checks the live role); this keeps a known owner out of committed configuration.
export const describeForbidden = forbiddenUserReason

if (process.argv[1] && /runtime-db-role-check\.ts$/.test(process.argv[1])) {
  const { violations, clients, checked } = scanRepository(process.cwd())
  if (violations.length) { console.error(violations.join('\n')); process.exit(1) }
  console.log(`Runtime DB role check passed: ${checked} file(s) scanned; ${clients.length} audited database client site(s) (${clients.filter((c) => c.runtime).length} runtime); ${APPROVED_POOL_HOLDERS.length} connection pool holder(s); ${APPROVED_TOOL_CLIENTS.length} tools script(s).`)
}
