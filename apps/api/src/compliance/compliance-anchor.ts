import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto'
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import type { PrismaClient } from '@prisma/client'
import { sha256Hex, type ComplianceArchive } from './compliance-archive'
import { GENESIS_SHA256, inScope, knownScopes } from './compliance-export'

/**
 * Signed checkpoints of the compliance hash chains (ADR 0067 amendment 4).
 *
 * After an export run, the exporter writes a checkpoint to the WORM archive. A checkpoint lists the stored chain head of every scope, links to
 * the previous checkpoint's hash, and is signed with an asymmetric key whose private half never leaves AWS KMS. Signing is separated from the
 * database: an owner of the database (or of the export role's password) can neither forge a checkpoint nor rewrite history that an earlier
 * checkpoint committed to, and anyone holding the archive and the public key can verify every checkpoint offline.
 *
 * Layout: `compliance/checkpoints/v1/<sequence, 10 digits>.json` (one write-once object per checkpoint) and `compliance/checkpoints/v1/keys/<key fingerprint>.pem`.
 * A checkpoint is written only when a head moved, so an idle platform does not grow the archive.
 */
export const CHECKPOINT_FORMAT_VERSION = 1
export const CHECKPOINT_PREFIX = 'compliance/checkpoints/v1/'
export const CHECKPOINT_ALGORITHM = 'ECDSA_SHA_256'

export interface ComplianceSigner {
  /** Stable identifier of the signing key (the KMS key ARN, or `local:<fingerprint>`). */
  readonly keyId: string
  /** True only for a key held by a KMS (the private key cannot be read). */
  readonly managed: boolean
  /** DER-encoded ECDSA P-256 signature over SHA-256(message). */
  sign(message: Buffer): Promise<Buffer>
  /** SPKI public key, PEM. */
  publicKeyPem(): Promise<string>
}

/** AWS KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY). Only the 32-byte digest is sent (MessageType DIGEST); the message never leaves the process. */
export class KmsComplianceSigner implements ComplianceSigner {
  readonly managed = true
  private pem: string | null = null
  constructor(private readonly client: KMSClient, readonly keyId: string) {
    if (!/^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+|alias\/[A-Za-z0-9/_-]+|[0-9a-f-]{36})$/.test(keyId)) throw new Error('Invalid KMS signing key id')
  }
  async sign(message: Buffer): Promise<Buffer> {
    const out = await this.client.send(new SignCommand({ KeyId: this.keyId, Message: createHash('sha256').update(message).digest(), MessageType: 'DIGEST', SigningAlgorithm: CHECKPOINT_ALGORITHM }))
    if (!out.Signature) throw new Error('KMS returned no signature')
    return Buffer.from(out.Signature)
  }
  async publicKeyPem(): Promise<string> {
    if (this.pem) return this.pem
    const out = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }))
    if (!out.PublicKey || out.KeySpec !== 'ECC_NIST_P256' || out.KeyUsage !== 'SIGN_VERIFY') throw new Error('The compliance signing key must be an ECC_NIST_P256 SIGN_VERIFY key')
    this.pem = createPublicKey({ key: Buffer.from(out.PublicKey), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString()
    return this.pem
  }
}

/** In-process key for local development and tests. Its private key lives in memory, so the CLI refuses it outside a local database. */
export class LocalComplianceSigner implements ComplianceSigner {
  readonly managed = false
  readonly keyId: string
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject
  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = pair.privateKey; this.publicKey = pair.publicKey
    this.keyId = `local:${keyFingerprint(this.publicKey.export({ type: 'spki', format: 'pem' }).toString())}`
  }
  async sign(message: Buffer): Promise<Buffer> { return nodeSign('sha256', message, this.privateKey) }
  async publicKeyPem(): Promise<string> { return this.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}

/** SHA-256 of the DER public key, hex: names the key file and binds a checkpoint to one key. */
export function keyFingerprint(pem: string): string {
  return sha256Hex(createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer)
}

export interface ScopeHead { scope: string; headSequence: number; headSha256: string }
export interface CheckpointBody {
  formatVersion: number
  sequence: number
  previousSha256: string
  createdAt: string
  keyId: string
  keyFingerprint: string
  algorithm: string
  scopes: ScopeHead[]
}
export interface CheckpointObject { checkpoint: CheckpointBody; checkpointSha256: string; signature: string }

/** Canonical bytes of a checkpoint: fixed key order, scopes sorted. These bytes are hashed and signed. */
export function canonicalCheckpoint(c: CheckpointBody): Buffer {
  return Buffer.from(JSON.stringify({
    formatVersion: c.formatVersion, sequence: c.sequence, previousSha256: c.previousSha256, createdAt: c.createdAt, keyId: c.keyId, keyFingerprint: c.keyFingerprint, algorithm: c.algorithm,
    scopes: [...c.scopes].sort((a, b) => a.scope.localeCompare(b.scope)).map((s) => ({ scope: s.scope, headSequence: s.headSequence, headSha256: s.headSha256 })),
  }), 'utf8')
}

export const checkpointKey = (sequence: number) => `${CHECKPOINT_PREFIX}${String(sequence).padStart(10, '0')}.json`
const keyObjectKey = (fingerprint: string) => `${CHECKPOINT_PREFIX}keys/${fingerprint}.pem`

async function readCheckpoints(archive: ComplianceArchive): Promise<Array<{ key: string; object: CheckpointObject | null }>> {
  const keys = (await archive.list(CHECKPOINT_PREFIX)).filter((k) => /\/\d{10}\.json$/.test(k)).sort()
  const out: Array<{ key: string; object: CheckpointObject | null }> = []
  for (const key of keys) {
    try { out.push({ key, object: JSON.parse((await archive.get(key))?.toString('utf8') ?? '') as CheckpointObject }) } catch { out.push({ key, object: null }) }
  }
  return out
}

/** The stored chain head of every scope, read per scope through row-level security (the compliance role sees one scope per transaction). */
export async function storedHeads(db: PrismaClient): Promise<ScopeHead[]> {
  const heads: ScopeHead[] = []
  for (const scope of await knownScopes(db)) {
    const head = await inScope(db, scope, (tx) => tx.complianceExportBatch.findFirst({ where: { scopeKey: scope, storageStatus: 'STORED' }, orderBy: { sequence: 'desc' }, select: { sequence: true, batchSha256: true } }))
    if (head) heads.push({ scope, headSequence: head.sequence, headSha256: head.batchSha256 })
  }
  return heads.sort((a, b) => a.scope.localeCompare(b.scope))
}

/**
 * Writes the next checkpoint when any stored head differs from the last checkpoint. Returns null when nothing moved.
 * Write-once keys make a concurrent writer fail loudly (archive conflict) instead of forking the checkpoint chain.
 */
export async function writeCheckpoint(archive: ComplianceArchive, signer: ComplianceSigner, heads: ScopeHead[], opts: { now?: () => Date; retainUntil: Date }): Promise<CheckpointObject | null> {
  const existing = await readCheckpoints(archive)
  const last = existing.length ? existing[existing.length - 1].object : null
  if (existing.length && !last) throw new Error(`Checkpoint ${existing[existing.length - 1].key} is unreadable; run verify`)
  const same = last && JSON.stringify(last.checkpoint.scopes) === JSON.stringify(heads)
  if (same) return null
  const pem = await signer.publicKeyPem()
  const fingerprint = keyFingerprint(pem)
  const pemBody = Buffer.from(pem, 'utf8')
  await archive.put({ key: keyObjectKey(fingerprint), body: pemBody, sha256: sha256Hex(pemBody), contentType: 'application/x-pem-file', retainUntil: opts.retainUntil })
  const checkpoint: CheckpointBody = {
    formatVersion: CHECKPOINT_FORMAT_VERSION, sequence: (last?.checkpoint.sequence ?? 0) + 1, previousSha256: last?.checkpointSha256 ?? GENESIS_SHA256,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(), keyId: signer.keyId, keyFingerprint: fingerprint, algorithm: CHECKPOINT_ALGORITHM, scopes: heads,
  }
  const bytes = canonicalCheckpoint(checkpoint)
  const object: CheckpointObject = { checkpoint, checkpointSha256: sha256Hex(bytes), signature: (await signer.sign(bytes)).toString('base64') }
  const body = Buffer.from(JSON.stringify(object, null, 2) + '\n', 'utf8')
  await archive.put({ key: checkpointKey(checkpoint.sequence), body, sha256: sha256Hex(body), contentType: 'application/json', retainUntil: opts.retainUntil })
  return object
}

export interface CheckpointReport { checkpoints: number; latest: CheckpointObject | null; failures: string[] }

/**
 * Verifies every checkpoint from the archive alone: signature against the archived public key (and, when given, that the key is the expected one),
 * sequence continuity, links, and that each signed head is a batch of that scope's archived chain with the same hash and that heads never move back.
 * `chains` maps scope -> batch hashes by sequence, from the archive walk (verifyArchiveChain); pass it to check heads against the archive.
 */
export async function verifyCheckpoints(archive: ComplianceArchive, chains: Map<string, Map<number, string>>, opts: { expectedKeyFingerprint?: string } = {}): Promise<CheckpointReport> {
  const failures: string[] = []
  const all = await readCheckpoints(archive)
  const keys = new Map<string, string | null>()
  let previous = GENESIS_SHA256
  let latest: CheckpointObject | null = null
  const lastHead = new Map<string, number>()
  for (const [index, { key, object }] of all.entries()) {
    const tag = `checkpoint ${key.slice(CHECKPOINT_PREFIX.length)}`
    if (!object?.checkpoint || typeof object.signature !== 'string') { failures.push(`${tag}: unreadable`); continue }
    const c = object.checkpoint
    if (c.formatVersion !== CHECKPOINT_FORMAT_VERSION || c.algorithm !== CHECKPOINT_ALGORITHM) failures.push(`${tag}: unknown format or algorithm`)
    if (c.sequence !== index + 1 || key !== checkpointKey(c.sequence)) failures.push(`${tag}: expected sequence ${index + 1} (a checkpoint is missing or misplaced)`)
    if (c.previousSha256 !== previous) failures.push(`${tag}: does not link to the previous checkpoint`)
    const bytes = canonicalCheckpoint(c)
    if (sha256Hex(bytes) !== object.checkpointSha256) failures.push(`${tag}: hash does not match its content`)
    if (opts.expectedKeyFingerprint && c.keyFingerprint !== opts.expectedKeyFingerprint) failures.push(`${tag}: signed by an unexpected key ${c.keyFingerprint}`)
    if (!keys.has(c.keyFingerprint)) keys.set(c.keyFingerprint, (await archive.get(keyObjectKey(c.keyFingerprint)))?.toString('utf8') ?? null)
    const pem = keys.get(c.keyFingerprint)
    if (!pem || keyFingerprint(pem) !== c.keyFingerprint) failures.push(`${tag}: public key ${c.keyFingerprint} is missing from the archive`)
    else if (!nodeVerify('sha256', bytes, createPublicKey(pem), Buffer.from(object.signature, 'base64'))) failures.push(`${tag}: signature is not valid`)
    for (const head of c.scopes) {
      const chain = chains.get(head.scope)
      if (chain && chain.get(head.headSequence) !== head.headSha256) failures.push(`${tag}: head ${head.scope}#${head.headSequence} is not in the archived chain`)
      if (!chain) failures.push(`${tag}: scope ${head.scope} has no archived chain`)
      if ((lastHead.get(head.scope) ?? 0) > head.headSequence) failures.push(`${tag}: head of ${head.scope} moved back`)
      lastHead.set(head.scope, head.headSequence)
    }
    previous = object.checkpointSha256
    latest = object
  }
  return { checkpoints: all.length, latest, failures }
}
