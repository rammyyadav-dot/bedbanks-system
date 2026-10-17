import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3ServiceException, type S3Client } from '@aws-sdk/client-s3'
import { ComplianceArchiveConflict, FileSystemComplianceArchive, S3ObjectLockComplianceArchive, sha256Hex } from './compliance-archive'
import { COMPLIANCE_CATEGORIES, COMPLIANCE_CLASSIFICATION, TEMPLATED_COMPLIANCE_ACTIONS, complianceCategoryFunctionSql, complianceCategoryOf } from './compliance-classification'
import {
  GENESIS_SHA256, batchObjectKey, batchSha256, manifestKey, renderBatchBody, renderManifest, type BatchManifest, type ComplianceRecordRow,
} from './compliance-export'
import { complianceGrantStatements } from './compliance-role'
import { verifyArchiveChain, verifyArchivedBatch } from './compliance-verify'
import { archiveFromEnv } from './compliance-ops.cli'

const root = join(__dirname, '..', '..')
const migrations = join(root, 'prisma', 'migrations')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [full] : []
  })
}

const record = (i: number, scope: string | null, payload: object = { requestId: `r${i}` }): ComplianceRecordRow => {
  const payloadText = JSON.stringify(payload)
  return {
    id: `rec-${i}`, tenantId: scope, category: 'RBAC_CHANGE', action: 'platform.role.assigned', entityType: 'platform_role_assignment', entityId: `u:${i}`, actorType: 'USER', userId: 'u1',
    occurredAt: new Date(Date.UTC(2026, 9, 17, 10, 0, i)), payloadText, payloadSha256: sha256Hex(payloadText), originCountry: null, destinationCountry: null, crossBorder: null,
  }
}

function seal(scope: string, sequence: number, previousSha256: string, records: ComplianceRecordRow[]): { manifest: BatchManifest; body: Buffer } {
  const body = renderBatchBody(records)
  const header = { scope, sequence, previousSha256, bodySha256: sha256Hex(body), recordCount: records.length, firstOccurredAt: records[0].occurredAt.toISOString(), lastOccurredAt: records[records.length - 1].occurredAt.toISOString() }
  const hash = batchSha256(header)
  return { body, manifest: { ...header, formatVersion: 1, batchSha256: hash, objectKey: batchObjectKey(scope, sequence, hash), retainUntil: '2033-10-17T00:00:00.000Z', sealedAt: '2026-10-17T00:00:00.000Z' } }
}

describe('compliance classification (the single definition)', () => {
  it('the latest migration that defines the SQL classifier equals the generated one', () => {
    const defining = readdirSync(migrations).filter((n) => statSync(join(migrations, n)).isDirectory()).sort()
      .filter((n) => read(migrations, n, 'migration.sql').includes('FUNCTION "fbeds_compliance_category"'))
    expect(defining.length).toBeGreaterThan(0)
    const sql = read(migrations, defining[defining.length - 1], 'migration.sql')
    expect(sql).toContain(complianceCategoryFunctionSql())
  })

  it('categories match the database and Prisma enums, and no action is in two categories', () => {
    const sql = read(migrations, '202611200001_compliance_reporting_hooks', 'migration.sql')
    expect(sql).toContain(`CREATE TYPE "ComplianceCategory" AS ENUM (${COMPLIANCE_CATEGORIES.map((c) => `'${c}'`).join(', ')});`)
    const prismaEnum = /enum ComplianceCategory \{([^}]*)\}/.exec(read(root, 'prisma', 'schema.prisma'))![1].trim().split(/\s+/)
    expect(prismaEnum).toEqual([...COMPLIANCE_CATEGORIES])
    const all = COMPLIANCE_CATEGORIES.flatMap((c) => COMPLIANCE_CLASSIFICATION[c])
    expect(new Set(all).size).toBe(all.length)
  })

  it('every classified action has a writer in the API source (a renamed action would silently stop being captured)', () => {
    const source = sourceFiles(join(root, 'src')).filter((f) => !f.includes(`${join('src', 'compliance')}`)).map((f) => readFileSync(f, 'utf8')).join('\n')
    const missing = COMPLIANCE_CATEGORIES.flatMap((c) => COMPLIANCE_CLASSIFICATION[c]).filter((a) => !TEMPLATED_COMPLIANCE_ACTIONS.includes(a) && !source.includes(`'${a}'`))
    expect({ missing }).toEqual({ missing: [] })
    expect(source).toContain('action: `approval.${input.decision.toLowerCase()}`')
  })

  it('classifies the governance events and ignores routine ones', () => {
    expect(complianceCategoryOf('platform.role.permissions.updated')).toBe('RBAC_CHANGE')
    expect(complianceCategoryOf('hotel.exported')).toBe('DATA_EXPORT')
    expect(complianceCategoryOf('booking.confirmed')).toBe('BOOKING_JURISDICTION')
    expect(complianceCategoryOf('hotel.search')).toBeNull()
    expect(complianceCategoryOf('auth.login.failure')).toBeNull()
  })
})

describe('compliance batch format and hash chain', () => {
  it('renders a deterministic body whose lines carry the exact payload text that was hashed', () => {
    const records = [record(1, 't1', { b: 1, a: 'x' }), record(2, 't1')]
    const body = renderBatchBody(records)
    expect(body.equals(renderBatchBody(records))).toBe(true)
    const [line] = body.toString('utf8').split('\n')
    expect(Object.keys(JSON.parse(line))).toEqual(['v', 'id', 'tenantId', 'category', 'action', 'entityType', 'entityId', 'actorType', 'userId', 'occurredAt', 'payloadSha256', 'payloadText', 'originCountry', 'destinationCountry', 'crossBorder'])
    expect(sha256Hex(JSON.parse(line).payloadText)).toBe(JSON.parse(line).payloadSha256)
  })

  it('verifies a genesis batch and refuses any edit, reorder, foreign record or broken link', () => {
    const { manifest, body } = seal('t1', 1, GENESIS_SHA256, [record(1, 't1'), record(2, 't1')])
    expect(verifyArchivedBatch(manifest, body, GENESIS_SHA256, 1).failures).toEqual([])
    const fail = (m: BatchManifest, b: Buffer | null, prev = GENESIS_SHA256, seq = 1) => verifyArchivedBatch(m, b, prev, seq).failures.join('\n')
    expect(fail(manifest, Buffer.from(body.toString().replace('rec-2', 'rec-9')))).toMatch(/body hash/)
    const swapped = seal('t1', 1, GENESIS_SHA256, [record(2, 't1'), record(1, 't1')])
    expect(fail(swapped.manifest, swapped.body)).toMatch(/out of order/)
    const foreign = seal('t1', 1, GENESIS_SHA256, [record(1, 't2')])
    expect(fail(foreign.manifest, foreign.body)).toMatch(/another scope/)
    expect(fail(manifest, body, 'a'.repeat(64))).toMatch(/does not link/)
    expect(fail({ ...manifest, recordCount: 3 }, body)).toMatch(/batch hash|manifest says/)
    const forgedPayload = { ...record(1, 't1'), payloadText: '{"requestId":"other"}' }
    const forged = seal('t1', 1, GENESIS_SHA256, [forgedPayload])
    expect(fail(forged.manifest, forged.body)).toMatch(/payload does not match/)
  })

  it('walks a chain from an archive and detects a missing batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fbeds-compliance-unit-'))
    try {
      const archive = new FileSystemComplianceArchive(dir)
      const one = seal('t1', 1, GENESIS_SHA256, [record(1, 't1')])
      const two = seal('t1', 2, one.manifest.batchSha256, [record(2, 't1')])
      const three = seal('t1', 3, two.manifest.batchSha256, [record(3, 't1')])
      const retainUntil = new Date('2033-01-01')
      for (const b of [one, three]) {
        await archive.put({ key: b.manifest.objectKey, body: b.body, sha256: b.manifest.bodySha256, contentType: 'application/x-ndjson', retainUntil })
        const m = renderManifest(b.manifest)
        await archive.put({ key: manifestKey(b.manifest.objectKey), body: m, sha256: sha256Hex(m), contentType: 'application/json', retainUntil })
      }
      const broken = await verifyArchiveChain(archive, 't1')
      expect(broken.failures.join('\n')).toMatch(/expected sequence 2/)
      await archive.put({ key: two.manifest.objectKey, body: two.body, sha256: two.manifest.bodySha256, contentType: 'application/x-ndjson', retainUntil })
      const m = renderManifest(two.manifest)
      await archive.put({ key: manifestKey(two.manifest.objectKey), body: m, sha256: sha256Hex(m), contentType: 'application/json', retainUntil })
      expect(await verifyArchiveChain(archive, 't1')).toMatchObject({ batches: 3, records: 3, headSha256: three.manifest.batchSha256, failures: [] })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('compliance archives', () => {
  const object = (body: string) => ({ key: 'compliance/v1/t1/0000000001-abc.ndjson', body: Buffer.from(body), sha256: sha256Hex(body), contentType: 'application/x-ndjson', retainUntil: new Date('2033-01-01') })

  it('filesystem: write-once, idempotent for identical bytes, refuses different bytes, digest mismatches and unsafe keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fbeds-compliance-fs-'))
    try {
      const archive = new FileSystemComplianceArchive(dir)
      await archive.put(object('a\n'))
      await expect(archive.put(object('a\n'))).resolves.toEqual({ versionId: null })
      await expect(archive.put(object('b\n'))).rejects.toBeInstanceOf(ComplianceArchiveConflict)
      await expect(archive.put({ ...object('a\n'), sha256: '0'.repeat(64) })).rejects.toThrow(/digest/)
      await expect(archive.put({ ...object('a\n'), key: '../escape' })).rejects.toThrow(/Invalid archive key/)
      expect((await archive.get(object('a\n').key))?.toString()).toBe('a\n')
      expect(await archive.list('compliance/v1/t1/')).toEqual([object('a\n').key])
      expect(archive.immutable).toBe(false)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  function fakeS3(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = []
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input })
      const handler = handlers[command.constructor.name]
      if (!handler) throw new Error(`unexpected ${command.constructor.name}`)
      return handler(command.input)
    } } as unknown as S3Client
    return { client, sent }
  }
  const s3Error = (status: number) => new S3ServiceException({ name: status === 404 ? 'NotFound' : 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: status } })

  it('S3: refuses a bucket without Object Lock', async () => {
    const { client } = fakeS3({ GetObjectLockConfigurationCommand: () => ({ ObjectLockConfiguration: {} }) })
    await expect(new S3ObjectLockComplianceArchive(client, 'fbeds-compliance').assertReady()).rejects.toThrow(/Object Lock/)
    const ok = fakeS3({ GetObjectLockConfigurationCommand: () => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }) })
    await expect(new S3ObjectLockComplianceArchive(ok.client, 'fbeds-compliance').assertReady()).resolves.toBeUndefined()
  })

  it('S3: writes in COMPLIANCE mode with retention, checksum and If-None-Match, and never replaces different bytes', async () => {
    const { client, sent } = fakeS3({ HeadObjectCommand: () => { throw s3Error(404) }, PutObjectCommand: () => ({ VersionId: 'v1' }) })
    await expect(new S3ObjectLockComplianceArchive(client, 'fbeds-compliance').put(object('a\n'))).resolves.toEqual({ versionId: 'v1' })
    expect(sent[1]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'fbeds-compliance', ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date('2033-01-01'), IfNoneMatch: '*', ChecksumSHA256: Buffer.from(sha256Hex('a\n'), 'hex').toString('base64'), Metadata: { 'fbeds-sha256': sha256Hex('a\n') } } })

    const same = fakeS3({ HeadObjectCommand: () => ({ Metadata: { 'fbeds-sha256': sha256Hex('a\n') }, VersionId: 'v1' }) })
    await expect(new S3ObjectLockComplianceArchive(same.client, 'fbeds-compliance').put(object('a\n'))).resolves.toEqual({ versionId: 'v1' })
    expect(same.sent.map((s) => s.name)).toEqual(['HeadObjectCommand'])
    const different = fakeS3({ HeadObjectCommand: () => ({ Metadata: { 'fbeds-sha256': sha256Hex('b\n') } }) })
    await expect(new S3ObjectLockComplianceArchive(different.client, 'fbeds-compliance').put(object('a\n'))).rejects.toBeInstanceOf(ComplianceArchiveConflict)

    let heads = 0
    const raced = fakeS3({ HeadObjectCommand: () => { if (heads++ === 0) throw s3Error(404); return { Metadata: { 'fbeds-sha256': sha256Hex('b\n') } } }, PutObjectCommand: () => { throw s3Error(412) } })
    await expect(new S3ObjectLockComplianceArchive(raced.client, 'fbeds-compliance').put(object('a\n'))).rejects.toBeInstanceOf(ComplianceArchiveConflict)
  })

  it('the CLI refuses a filesystem archive for a remote database and requires one archive', () => {
    expect(() => archiveFromEnv({ COMPLIANCE_ARCHIVE_DIR: '/tmp/x' }, false)).toThrow(/not WORM/)
    expect(() => archiveFromEnv({}, true)).toThrow(/No compliance archive/)
    expect(() => archiveFromEnv({ COMPLIANCE_ARCHIVE_DIR: '/tmp/x', COMPLIANCE_ARCHIVE_BUCKET: 'b-b-b' }, true)).toThrow(/not both/)
    expect(archiveFromEnv({ COMPLIANCE_ARCHIVE_BUCKET: 'fbeds-compliance', AWS_REGION: 'me-central-1' }, false).immutable).toBe(true)
  })
})

describe('compliance role', () => {
  it('grants read on the compliance tables, insert on batches only, the storage status columns and the two scope functions; nothing else', () => {
    expect(complianceGrantStatements()).toEqual([
      'GRANT USAGE ON SCHEMA public TO "fbeds_compliance"',
      'GRANT SELECT ON "ComplianceRecord" TO "fbeds_compliance"',
      'GRANT SELECT ON "ComplianceExportBatch" TO "fbeds_compliance"',
      'GRANT SELECT ON "ComplianceExportBatchRecord" TO "fbeds_compliance"',
      'GRANT INSERT ON "ComplianceExportBatch" TO "fbeds_compliance"',
      'GRANT INSERT ON "ComplianceExportBatchRecord" TO "fbeds_compliance"',
      'GRANT UPDATE ("storage_status", "stored_at", "object_version_id") ON "ComplianceExportBatch" TO "fbeds_compliance"',
      'GRANT EXECUTE ON FUNCTION "fbeds_compliance_due_scopes"() TO "fbeds_compliance"',
      'GRANT EXECUTE ON FUNCTION "fbeds_compliance_known_scopes"() TO "fbeds_compliance"',
    ])
  })
})
