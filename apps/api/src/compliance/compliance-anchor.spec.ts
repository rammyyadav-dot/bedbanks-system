import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KMSClient } from '@aws-sdk/client-kms'
import { FileSystemComplianceArchive } from './compliance-archive'
import { CHECKPOINT_PREFIX, KmsComplianceSigner, LocalComplianceSigner, checkpointKey, keyFingerprint, verifyCheckpoints, writeCheckpoint, type CheckpointObject, type ScopeHead } from './compliance-anchor'
import { signerFromEnv } from './compliance-ops.cli'

const h = (n: number) => createHash('sha256').update(String(n)).digest('hex')
const retainUntil = new Date('2033-01-01T00:00:00.000Z')
const chains = (entries: Array<[string, number]>) => new Map(entries.map(([scope, upTo]) => [scope, new Map(Array.from({ length: upTo }, (_, i) => [i + 1, h(i + 1)] as [number, string]))]))
const heads = (entries: Array<[string, number]>): ScopeHead[] => entries.map(([scope, seq]) => ({ scope, headSequence: seq, headSha256: h(seq) }))

describe('signed compliance checkpoints (ADR 0067 amendment 4)', () => {
  let dir: string
  let archive: FileSystemComplianceArchive
  const signer = new LocalComplianceSigner()
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fbeds-checkpoint-')); archive = new FileSystemComplianceArchive(dir) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = (key: string) => join(dir, ...key.split('/'))
  async function rewrite(key: string, edit: (o: CheckpointObject) => void) {
    const o = JSON.parse(await readFile(path(key), 'utf8')) as CheckpointObject
    edit(o); await chmod(path(key), 0o644); await writeFile(path(key), JSON.stringify(o))
  }

  it('writes a linked, signed checkpoint only when a head moves, and verifies offline from the archive', async () => {
    const first = await writeCheckpoint(archive, signer, heads([['platform', 1], ['t1', 2]]), { retainUntil })
    expect(first?.checkpoint).toMatchObject({ sequence: 1, previousSha256: '0'.repeat(64), keyId: signer.keyId, algorithm: 'ECDSA_SHA_256' })
    expect(await writeCheckpoint(archive, signer, heads([['platform', 1], ['t1', 2]]), { retainUntil })).toBeNull()
    const second = await writeCheckpoint(archive, signer, heads([['platform', 1], ['t1', 3]]), { retainUntil })
    expect(second?.checkpoint).toMatchObject({ sequence: 2, previousSha256: first!.checkpointSha256 })
    expect(await archive.list(CHECKPOINT_PREFIX)).toEqual([`${CHECKPOINT_PREFIX}0000000001.json`, `${CHECKPOINT_PREFIX}0000000002.json`, `${CHECKPOINT_PREFIX}keys/${keyFingerprint(await signer.publicKeyPem())}.pem`])
    const report = await verifyCheckpoints(archive, chains([['platform', 1], ['t1', 3]]), { expectedKeyFingerprint: keyFingerprint(await signer.publicKeyPem()) })
    expect(report).toMatchObject({ checkpoints: 2, failures: [] })
    expect(report.latest?.checkpointSha256).toBe(second!.checkpointSha256)
  })

  it('detects an altered checkpoint, a forged signature, a missing checkpoint and a foreign key', async () => {
    await writeCheckpoint(archive, signer, heads([['t1', 1]]), { retainUntil })
    await writeCheckpoint(archive, signer, heads([['t1', 2]]), { retainUntil })
    const ok = chains([['t1', 2]])
    await rewrite(checkpointKey(1), (o) => { o.checkpoint.scopes[0].headSha256 = h(9) })
    expect((await verifyCheckpoints(archive, ok)).failures.join('\n')).toMatch(/hash does not match its content[\s\S]*signature is not valid/)

    const other = new LocalComplianceSigner()
    const forged = await other.sign(Buffer.from('anything'))
    await rewrite(checkpointKey(1), (o) => { o.checkpoint.scopes[0].headSha256 = h(1); o.signature = forged.toString('base64') })
    expect((await verifyCheckpoints(archive, ok)).failures.join('\n')).toMatch(/checkpoint 0000000001.json: signature is not valid/)

    expect((await verifyCheckpoints(archive, ok, { expectedKeyFingerprint: keyFingerprint(await other.publicKeyPem()) })).failures.join('\n')).toMatch(/unexpected key/)
    await unlink(path(checkpointKey(1)))
    expect((await verifyCheckpoints(archive, ok)).failures.join('\n')).toMatch(/expected sequence 1[\s\S]*does not link/)
  })

  it('fails when a signed head is not in the archived chain, or a chain head moves back', async () => {
    await writeCheckpoint(archive, signer, heads([['t1', 3]]), { retainUntil })
    expect((await verifyCheckpoints(archive, chains([['t1', 2]]))).failures.join('\n')).toMatch(/head t1#3 is not in the archived chain/)
    expect((await verifyCheckpoints(archive, new Map())).failures.join('\n')).toMatch(/scope t1 has no archived chain/)
    await writeCheckpoint(archive, signer, heads([['t1', 2]]), { retainUntil })
    expect((await verifyCheckpoints(archive, chains([['t1', 3]]))).failures.join('\n')).toMatch(/head of t1 moved back/)
  })

  it('refuses to continue from an unreadable last checkpoint', async () => {
    await writeCheckpoint(archive, signer, heads([['t1', 1]]), { retainUntil })
    await chmod(path(checkpointKey(1)), 0o644); await writeFile(path(checkpointKey(1)), 'not json')
    await expect(writeCheckpoint(archive, signer, heads([['t1', 2]]), { retainUntil })).rejects.toThrow(/unreadable/)
  })

  it('KMS signer sends only the SHA-256 digest and refuses a key that is not ECC_NIST_P256 SIGN_VERIFY', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const sent: Array<{ name: string; input: Record<string, unknown> }> = []
    const client = (keySpec: string) => ({ send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'SignCommand') return { Signature: new Uint8Array([1, 2, 3]) }
      return { PublicKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })), KeySpec: keySpec, KeyUsage: 'SIGN_VERIFY' }
    } }) as unknown as KMSClient
    const arn = 'arn:aws:kms:ap-south-1:123456789012:key/11111111-2222-3333-4444-555555555555'
    const kms = new KmsComplianceSigner(client('ECC_NIST_P256'), arn)
    expect(kms.managed).toBe(true)
    await kms.sign(Buffer.from('checkpoint bytes'))
    expect(sent[0]).toEqual({ name: 'SignCommand', input: { KeyId: arn, Message: createHash('sha256').update('checkpoint bytes').digest(), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' } })
    expect(await kms.publicKeyPem()).toContain('BEGIN PUBLIC KEY')
    await expect(new KmsComplianceSigner(client('RSA_2048'), arn).publicKeyPem()).rejects.toThrow(/ECC_NIST_P256/)
    expect(() => new KmsComplianceSigner(client('ECC_NIST_P256'), 'not a key')).toThrow(/Invalid KMS signing key id/)
  })

  it('the CLI uses KMS when configured and refuses the in-memory signer for a remote database', () => {
    expect(signerFromEnv({}, false)).toBeNull()
    expect(signerFromEnv({ COMPLIANCE_SIGNING_KEY_ID: 'alias/fbeds-staging-compliance-signing', AWS_REGION: 'ap-south-1' }, false)?.managed).toBe(true)
    expect(() => signerFromEnv({ COMPLIANCE_LOCAL_SIGNER: 'true' }, false)).toThrow(/local development only/)
    expect(signerFromEnv({ COMPLIANCE_LOCAL_SIGNER: 'true' }, true)?.managed).toBe(false)
    expect(() => signerFromEnv({ COMPLIANCE_LOCAL_SIGNER: 'true', COMPLIANCE_SIGNING_KEY_ID: 'alias/x' }, true)).toThrow(/not both/)
  })
})
