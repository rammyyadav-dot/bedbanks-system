/**
 * Operational commands of the compliance reporting hooks (ADR 0067). Run on a schedule (export, then verify) and by the owner (provisioning).
 *
 *   provision    owner connection: create/refresh the restricted compliance role
 *                PROVISION_DATABASE_URL, COMPLIANCE_LOGIN_PASSWORD [, COMPLIANCE_LOGIN_ROLE] [--allow-remote --confirm-database=<name>]
 *   verify-role  connects AS the compliance role and checks its privileges in both directions
 *   export       seals and stores every due scope; exits 1 if any scope failed
 *   verify       walks every scope's chain in the archive and cross-checks the database; exits 1 on any failure
 *
 * export / verify / verify-role use COMPLIANCE_DATABASE_URL (the compliance role, never the owner or the API role) and one archive:
 *   COMPLIANCE_ARCHIVE_BUCKET=<S3 bucket with Object Lock> (AWS_REGION; credentials from the task role), or
 *   COMPLIANCE_ARCHIVE_DIR=<directory>  local development only: refused unless the database host is local.
 * Optional: COMPLIANCE_RETENTION_DAYS (default 2557, minimum 365), COMPLIANCE_BATCH_SIZE (default 1000), COMPLIANCE_MAX_LAG_HOURS (default 24).
 * Never prints a URL, password, payload or raw error message.
 */
import { S3Client } from '@aws-sdk/client-s3'
import { PrismaClient } from '@prisma/client'
import { assertRuntimeDbIdentity } from '../database/runtime-db-identity'
import { normalizeOpsDatabaseUrl } from '../database/ops-database-url'
import { checkTarget } from '../database/provision-hold-expiry-role.cli'
import { FileSystemComplianceArchive, S3ObjectLockComplianceArchive, type ComplianceArchive } from './compliance-archive'
import { ARCHIVE_ROOT, DEFAULT_BATCH_SIZE, DEFAULT_RETENTION_DAYS, PLATFORM_SCOPE, exportDue, knownScopes } from './compliance-export'
import { COMPLIANCE_GROUP_ROLE, COMPLIANCE_LOGIN_ROLE, assertComplianceRoleInput, describePasswordProblems, provisionComplianceRole, verifyComplianceRole } from './compliance-role'
import { verifyScope } from './compliance-verify'

const integer = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`)
  return Number(raw)
}

export function archiveFromEnv(env: Record<string, string | undefined>, databaseIsLocal: boolean): ComplianceArchive {
  if (env.COMPLIANCE_ARCHIVE_BUCKET && env.COMPLIANCE_ARCHIVE_DIR) throw new Error('Set either COMPLIANCE_ARCHIVE_BUCKET or COMPLIANCE_ARCHIVE_DIR, not both')
  if (env.COMPLIANCE_ARCHIVE_BUCKET) return new S3ObjectLockComplianceArchive(new S3Client({ region: env.AWS_REGION }), env.COMPLIANCE_ARCHIVE_BUCKET)
  if (env.COMPLIANCE_ARCHIVE_DIR) {
    if (!databaseIsLocal) throw new Error('COMPLIANCE_ARCHIVE_DIR is for local development only: a filesystem is not WORM storage. Use COMPLIANCE_ARCHIVE_BUCKET')
    return new FileSystemComplianceArchive(env.COMPLIANCE_ARCHIVE_DIR)
  }
  throw new Error('No compliance archive configured: set COMPLIANCE_ARCHIVE_BUCKET')
}

async function withComplianceDb<T>(work: (db: PrismaClient, local: boolean) => Promise<T>): Promise<T> {
  const target = normalizeOpsDatabaseUrl(process.env.COMPLIANCE_DATABASE_URL)
  const db = new PrismaClient({ datasourceUrl: target.url })
  try {
    await assertRuntimeDbIdentity(db, 'Compliance exporter')
    return await work(db, target.local)
  } finally {
    await db.$disconnect()
  }
}

async function provision(): Promise<void> {
  const url = process.env.PROVISION_DATABASE_URL
  const password = process.env.COMPLIANCE_LOGIN_PASSWORD ?? ''
  const loginRole = process.env.COMPLIANCE_LOGIN_ROLE || COMPLIANCE_LOGIN_ROLE
  if (!url) throw new Error('PROVISION_DATABASE_URL is required')
  try { assertComplianceRoleInput(loginRole, password) } catch (error) {
    const base = error instanceof Error ? error.message : 'invalid role name or password'
    const details = /^Password/.test(base) ? describePasswordProblems(password) : []
    throw new Error(details.length ? `${base}. Problem: ${details.join('; ')}` : base)
  }
  const target = checkTarget(url, process.argv.slice(3))
  const db = new PrismaClient({ datasourceUrl: url })
  try {
    await provisionComplianceRole(db, { loginRole, password })
    console.log(`Provisioned login role "${loginRole}" (member of ${COMPLIANCE_GROUP_ROLE}) on database "${target.database}".`)
    console.log('Build COMPLIANCE_DATABASE_URL from the same host and database with this role, store it in the secret manager, and never commit it.')
  } finally {
    await db.$disconnect()
  }
}

async function main(command: string | undefined): Promise<number> {
  switch (command) {
    case 'provision':
      await provision()
      return 0
    case 'verify-role':
      return withComplianceDb(async (db) => {
        const report = await verifyComplianceRole(db)
        for (const failure of report.failures) console.log(`FAIL: ${failure}`)
        console.log(report.ok ? 'Compliance role verified.' : 'Compliance role verification failed.')
        return report.ok ? 0 : 1
      })
    case 'export':
      return withComplianceDb(async (db, local) => {
        const archive = archiveFromEnv(process.env, local)
        const { exported, failed } = await exportDue(db, { archive, retentionDays: integer('COMPLIANCE_RETENTION_DAYS', DEFAULT_RETENTION_DAYS), batchSize: integer('COMPLIANCE_BATCH_SIZE', DEFAULT_BATCH_SIZE) })
        for (const scope of exported) for (const b of scope.stored) console.log(`stored ${scope.scope}#${b.sequence} records=${b.recordCount} sha256=${b.batchSha256} key=${b.objectKey}`)
        for (const f of failed) console.log(`FAIL: scope ${f.scope}: ${f.error}`)
        console.log(`Compliance export to ${archive.description}: ${exported.reduce((n, s) => n + s.stored.length, 0)} batch(es) stored, ${failed.length} scope(s) failed.`)
        return failed.length ? 1 : 0
      })
    case 'verify':
      return withComplianceDb(async (db, local) => {
        const archive = archiveFromEnv(process.env, local)
        const scopes = new Set<string>([PLATFORM_SCOPE, ...await knownScopes(db)])
        for (const key of await archive.list(ARCHIVE_ROOT)) scopes.add(key.slice(ARCHIVE_ROOT.length).split('/')[0])
        let failures = 0
        for (const scope of [...scopes].sort()) {
          const report = await verifyScope(db, archive, scope, { maxLagHours: integer('COMPLIANCE_MAX_LAG_HOURS', 24) })
          for (const failure of report.failures) console.log(`FAIL: ${failure}`)
          failures += report.failures.length
          console.log(`${scope}: ${report.batches} batch(es), ${report.records} record(s), head ${report.headSha256}, ${report.sealedNotStored} sealed not stored`)
        }
        console.log(failures ? `Compliance verification failed: ${failures} problem(s).` : 'Compliance archive verified.')
        return failures ? 1 : 0
      })
    default:
      console.error('Usage: compliance-ops <provision|verify-role|export|verify>')
      return 2
  }
}

if (require.main === module) {
  main(process.argv[2]).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error && !/postgres(ql)?:\/\//.test(error.message) ? error.message : 'Compliance command failed')
    process.exit(1)
  })
}
