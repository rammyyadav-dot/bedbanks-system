import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  GetObjectCommand, GetObjectLockConfigurationCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException,
} from '@aws-sdk/client-s3'

/**
 * Where sealed compliance batches are kept (ADR 0067). Objects are write-once: `put` of an existing key succeeds only when the bytes are identical
 * (a retried upload), and fails with `ComplianceArchiveConflict` otherwise. Nothing is ever overwritten or deleted through this port.
 */
export interface ArchiveObject {
  key: string
  body: Buffer
  /** Lower-case hex SHA-256 of `body`. */
  sha256: string
  contentType: string
  retainUntil: Date
}

export interface ComplianceArchive {
  /** Short description for logs; never contains a credential. */
  readonly description: string
  /** True only for storage that enforces retention itself (S3 Object Lock in COMPLIANCE mode). */
  readonly immutable: boolean
  /** Fails closed when the storage cannot guarantee write-once retention. */
  assertReady(): Promise<void>
  put(object: ArchiveObject): Promise<{ versionId: string | null }>
  get(key: string): Promise<Buffer | null>
  list(prefix: string): Promise<string[]>
}

export class ComplianceArchiveConflict extends Error {
  constructor(readonly key: string) { super(`Archive object ${key} already exists with different content`) }
}

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,1023}$/
function assertKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) throw new Error('Invalid archive key')
}
function assertDigest(object: ArchiveObject): void {
  assertKey(object.key)
  if (sha256Hex(object.body) !== object.sha256) throw new Error(`Archive object ${object.key} does not match its digest`)
}

/**
 * Local directory archive for development and tests. Files are created exclusively and made read-only, but a filesystem cannot enforce retention,
 * so `immutable` is false and the exporter CLI refuses it outside a local database.
 */
export class FileSystemComplianceArchive implements ComplianceArchive {
  readonly immutable = false
  constructor(private readonly root: string) {}
  get description(): string { return `filesystem:${this.root}` }

  async assertReady(): Promise<void> { await mkdir(this.root, { recursive: true }) }

  async put(object: ArchiveObject): Promise<{ versionId: string | null }> {
    assertDigest(object)
    const path = join(this.root, ...object.key.split('/'))
    await mkdir(dirname(path), { recursive: true })
    try {
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o444)
      try { await handle.writeFile(object.body) } finally { await handle.close() }
      await chmod(path, 0o444)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (sha256Hex(await readFile(path)) !== object.sha256) throw new ComplianceArchiveConflict(object.key)
    }
    return { versionId: null }
  }

  async get(key: string): Promise<Buffer | null> {
    assertKey(key)
    try { return await readFile(join(this.root, ...key.split('/'))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else out.push(relative(this.root, full).split(sep).join('/'))
      }
    }
    await walk(this.root)
    return out.filter((key) => key.startsWith(prefix)).sort()
  }
}

/**
 * Amazon S3 with Object Lock. Every object is written with `ObjectLockMode: COMPLIANCE` and its retain-until date, a SHA-256 checksum S3 verifies,
 * and `If-None-Match: *` so a concurrent writer cannot replace it. `assertReady` refuses a bucket without Object Lock enabled.
 * Credentials come from the standard AWS provider chain (the task role); none are read or logged here.
 */
export class S3ObjectLockComplianceArchive implements ComplianceArchive {
  readonly immutable = true
  constructor(private readonly client: S3Client, private readonly bucket: string) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid S3 bucket name')
  }
  get description(): string { return `s3://${this.bucket}` }

  async assertReady(): Promise<void> {
    const config = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.bucket }))
    if (config.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') throw new Error(`Bucket ${this.bucket} does not have S3 Object Lock enabled`)
  }

  async put(object: ArchiveObject): Promise<{ versionId: string | null }> {
    assertDigest(object)
    const existing = await this.head(object.key)
    if (existing) {
      if (existing.sha256 !== object.sha256) throw new ComplianceArchiveConflict(object.key)
      return { versionId: existing.versionId }
    }
    try {
      const out = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: object.key, Body: object.body, ContentType: object.contentType,
        ChecksumSHA256: Buffer.from(object.sha256, 'hex').toString('base64'),
        ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: object.retainUntil,
        Metadata: { 'fbeds-sha256': object.sha256 }, IfNoneMatch: '*',
      }))
      return { versionId: out.VersionId ?? null }
    } catch (error) {
      // A concurrent exporter won the race: accept it only when it stored the same bytes.
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        const raced = await this.head(object.key)
        if (raced?.sha256 === object.sha256) return { versionId: raced.versionId }
        throw new ComplianceArchiveConflict(object.key)
      }
      throw error
    }
  }

  async get(key: string): Promise<Buffer | null> {
    assertKey(key)
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null
      throw error
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return keys.sort()
  }

  private async head(key: string): Promise<{ sha256: string | null; versionId: string | null } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { sha256: out.Metadata?.['fbeds-sha256'] ?? null, versionId: out.VersionId ?? null }
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null
      throw error
    }
  }
}
