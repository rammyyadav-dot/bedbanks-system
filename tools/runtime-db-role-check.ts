// P0-01 (ADR 0040) architecture guard: runtime processes must be configured with the restricted database login, never the migration owner, and no new database
// client may appear outside the audited list. Static only: it reads repository files and parses user@host/db out of literal URLs. It never prints a password.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkRuntimeUrl, describeDatabaseUrl, forbiddenUserReason } from '../apps/api/src/database/runtime-db-identity'

/** Variables a deployed service reads at runtime. Their literal values must be the restricted logins. */
export const RUNTIME_DB_VARS = ['DATABASE_URL', 'BOOKING_OPS_DATABASE_URL', 'HOLD_EXPIRY_DATABASE_URL'] as const
/** Variables that carry owner or administrator credentials. They belong to release jobs and operators only, never to a service definition. */
export const OWNER_ONLY_VARS = ['MIGRATION_DATABASE_URL', 'PROVISION_DATABASE_URL', 'OWNER_DATABASE_URL', 'DIRECT_URL', 'DATABASE_URL_UNPOOLED'] as const

/** Every place a PrismaClient may be constructed in application source (under apps and packages source, plus apps/api/prisma). Anything else is a violation. */
export const APPROVED_CLIENTS: ReadonlyArray<{ file: string; purpose: string; url: string; runtime: boolean }> = [
  { file: 'apps/api/src/database/prisma.service.ts', purpose: 'HTTP runtime client (also used for the booking and hold-expiry connections); identity-checked at startup', url: 'DATABASE_URL / BOOKING_OPS_DATABASE_URL / HOLD_EXPIRY_DATABASE_URL', runtime: true },
  { file: 'apps/api/src/database/provision-api-runtime-role.cli.ts', purpose: 'operator: provisions the API login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-booking-ops-role.cli.ts', purpose: 'operator: provisions the booking login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-hold-expiry-role.cli.ts', purpose: 'operator: provisions the hold-expiry login', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/provision-preview-fixtures.cli.ts', purpose: 'operator: preview fixtures (refuses non-preview targets)', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/bootstrap-first-admin.cli.ts', purpose: 'operator: first admin bootstrap', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/hold-expiry-ops.cli.ts', purpose: 'operator: owner client plus restricted verification client', url: 'PROVISION_DATABASE_URL / HOLD_EXPIRY_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/database/strict-role-rollout.cli.ts', purpose: 'operator: rollout status (owner) and verify (runtime login)', url: 'PROVISION_DATABASE_URL / API_DATABASE_URL', runtime: false },
  { file: 'apps/api/src/inventory/pool-night-authoring.cli.ts', purpose: 'operator: pool night authoring', url: 'PROVISION_DATABASE_URL', runtime: false },
  { file: 'apps/api/prisma/seed.ts', purpose: 'developer seed (never run in a deployment)', url: 'DATABASE_URL', runtime: false },
]

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

export function checkClientSource(file: string, text: string): string[] {
  if (!/new\s+PrismaClient\s*\(|extends\s+PrismaClient\b/.test(text)) return []
  return APPROVED_CLIENTS.some((c) => c.file === file) ? [] : [`${file}: constructs a PrismaClient that is not in the audited client list (tools/runtime-db-role-check.ts). Route it through PrismaService or add it with its purpose, URL source and role.`]
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
  for (const base of ['apps/api/src', 'apps/api/prisma', 'apps/admin', 'apps/agent', 'apps/supplier', 'apps/website', 'packages']) {
    for (const file of walk(join(root, base), (p) => /\.(ts|tsx|js|mjs|cjs)$/.test(p) && !/\.(spec|test|e2e-spec)\./.test(p) && !p.includes('/test/') && !p.includes('/migrations/'))) {
      const text = readFileSync(file, 'utf8')
      checked += 1
      violations.push(...checkClientSource(rel(file), text))
      if (!base.startsWith('apps/api') && /from\s+['"]@prisma\/client['"]/.test(text)) violations.push(`${rel(file)}: only the API may import @prisma/client`)
    }
  }
  return { violations, clients: APPROVED_CLIENTS, checked }
}

// A name is never proof of safety (the startup guard checks the live role); this keeps a known owner out of committed configuration.
export const describeForbidden = forbiddenUserReason

if (process.argv[1] && /runtime-db-role-check\.ts$/.test(process.argv[1])) {
  const { violations, clients, checked } = scanRepository(process.cwd())
  if (violations.length) { console.error(violations.join('\n')); process.exit(1) }
  console.log(`Runtime DB role check passed: ${checked} file(s) scanned; ${clients.length} audited database client site(s) (${clients.filter((c) => c.runtime).length} runtime).`)
}
