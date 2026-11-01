/**
 * Operational commands for the hold-expiry role, driven by the manual GitHub
 * workflow `.github/workflows/provision-hold-expiry-role.yml` (ADR 0005).
 *
 *   preflight   read-only: checks target, migration state; exits 1 if unsafe
 *   export-env  writes DATABASE_URL to $GITHUB_ENV (masked) for prisma migrate
 *   provision   creates/updates the restricted role (owner connection)
 *   verify      connects AS the restricted role and checks it; exits 1 on failure
 *
 * Environment: OWNER_DATABASE_URL, CONFIRM_DATABASE, MODE (status-only|apply),
 * TARGET (nonprod|production), ALLOW_CATCH_UP (nonprod only), EXPECTED_PENDING (comma list), HOLD_EXPIRY_LOGIN_ROLE, HOLD_EXPIRY_LOGIN_PASSWORD.
 * Never prints a URL, password or error message that could contain either.
 */
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { assertProvisioningInput, describePasswordProblems, provisionHoldExpiryRole, verifyHoldExpiryRole } from './hold-expiry-role'
import { assessMigrations, type MigrationRow } from './hold-expiry-migrations'
import { normalizeOpsDatabaseUrl, withCredentials } from './ops-database-url'

const POLICY = 'AuditEvent_hold_expiry_system_insert'
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations')

function note(line: string): void {
  console.log(line)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, `${line}\n`)
}

function fail(message: string): never {
  note(`FAIL: ${message}`)
  process.exit(1)
}

/** Validation messages from assertProvisioningInput never contain the input, so they are safe to show. */
function checkCredentials(): void {
  const password = process.env.HOLD_EXPIRY_LOGIN_PASSWORD ?? ''
  try { assertProvisioningInput(loginRole(), password) } catch (error) {
    const base = error instanceof Error ? error.message : 'invalid role name or password'
    const details = /^Password/.test(base) ? describePasswordProblems(password) : []
    fail(details.length ? `${base}. Problem: ${details.join('; ')}. Edit the HOLD_EXPIRY_LOGIN_PASSWORD secret in this GitHub environment.` : base)
  }
}

function loginRole(): string { return process.env.HOLD_EXPIRY_LOGIN_ROLE || 'fbeds_hold_expiry_login' }

function ownerTarget() {
  const target = normalizeOpsDatabaseUrl(process.env.OWNER_DATABASE_URL)
  if (target.pooled) fail('the owner connection string is a pooled one (host contains -pooler); use the direct connection')
  if (!process.env.CONFIRM_DATABASE || process.env.CONFIRM_DATABASE !== target.database) fail('the confirmation database name does not match the target database')
  return target
}

async function preflight(): Promise<void> {
  const target = ownerTarget()
  const mode = process.env.MODE === 'apply' ? 'apply' : 'status-only'
  if (mode === 'apply') checkCredentials()
  const prisma = new PrismaClient({ datasourceUrl: target.url })
  try {
    const rows = await prisma.$queryRawUnsafe<MigrationRow[]>('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations')
    const directories = readdirSync(MIGRATIONS_DIR).filter(name => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
    const expected = (process.env.EXPECTED_PENDING ?? '').split(',').map(name => name.trim()).filter(Boolean)
    const catchUp = process.env.ALLOW_CATCH_UP === 'true'
    if (catchUp && process.env.TARGET !== 'nonprod') fail('catch-up is only allowed for the nonprod target')
    const result = assessMigrations(directories, rows, expected, { allowCatchUp: catchUp })
    if (catchUp) note('Catch-up enabled (nonprod only): any pending migrations will be applied, not just the expected one')
    note(`Target database: ${target.database} on ${target.host}`)
    note(`Mode: ${mode}`)
    note(`Migrations applied: ${result.applied.length}; pending: ${result.pending.length ? result.pending.join(', ') : 'none'}`)
    if (result.rolledBack.length) note(`Earlier repairs already marked rolled back (ignored): ${result.rolledBack.length}`)
    if (result.failed.length) note(`Unresolved failed migrations: ${result.failed.join(', ')}`)
    if (result.unknownApplied.length) note(`Applied but unknown to this repo: ${result.unknownApplied.join(', ')}`)
    if (result.unexpectedPending.length) note(`Unexpected pending: ${result.unexpectedPending.join(', ')}`)
    if (!result.safeToApply) fail('migration state is not the expected one; nothing was changed. See docs/production-migration-repair-runbook-2026-09-27.md')
    note('Migration state: as expected (safe to apply)')
  } finally {
    await prisma.$disconnect()
  }
}

function exportEnv(): void {
  const target = ownerTarget()
  const file = process.env.GITHUB_ENV
  if (!file) fail('GITHUB_ENV is not set (this command is for GitHub Actions)')
  console.log(`::add-mask::${target.url}`)
  appendFileSync(file, `DATABASE_URL=${target.url}\n`)
}

async function provision(): Promise<void> {
  const target = ownerTarget()
  checkCredentials()
  const password = process.env.HOLD_EXPIRY_LOGIN_PASSWORD ?? ''
  const prisma = new PrismaClient({ datasourceUrl: target.url })
  try {
    await provisionHoldExpiryRole(prisma, { loginRole: loginRole(), password })
    note(`Provisioned login role "${loginRole()}" on database "${target.database}"`)
  } finally {
    await prisma.$disconnect()
  }
}

async function verify(): Promise<void> {
  const target = ownerTarget()
  checkCredentials()
  const password = process.env.HOLD_EXPIRY_LOGIN_PASSWORD ?? ''
  const owner = new PrismaClient({ datasourceUrl: target.url })
  try {
    const [policy] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_policies WHERE policyname = '${POLICY}'`)
    if (Number(policy?.n ?? 0) !== 1) fail(`policy ${POLICY} is missing; apply the migration first`)
  } finally {
    await owner.$disconnect()
  }
  const restricted = new PrismaClient({ datasourceUrl: withCredentials(target.url, loginRole(), password) })
  try {
    const report = await verifyHoldExpiryRole(restricted)
    if (!report.ok) fail(`role check failed: ${report.failures.join('; ')}`)
    note('Role check passed: login works, no elevated attributes, no table ownership, no access outside hold-expiry scope, SYSTEM audit policy present')
    note('Next: set HOLD_EXPIRY_DATABASE_URL (same host and database, this role and password) where the API runs. Do not enable the sweeper before then.')
  } finally {
    await restricted.$disconnect()
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'preflight') return preflight()
  if (command === 'export-env') return exportEnv()
  if (command === 'provision') return provision()
  if (command === 'verify') return verify()
  fail('usage: hold-expiry-ops.cli.ts preflight|export-env|provision|verify')
}

main().catch((error: unknown) => {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : ''
  fail(`${error instanceof Error ? error.name : 'Error'}${code ? ` (${code})` : ''}; details withheld to avoid leaking credentials`)
})
