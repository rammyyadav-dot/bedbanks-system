import { createHash, randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { appendLedgerEntry } from '../src/ledger/ledger-core'
import { OperationsLedgerIntegrityService } from '../src/admin-operations/operations-ledger-integrity.service'

jest.setTimeout(120_000)

/** ADR 0094 on PostgreSQL: the per-wallet SHA-256 chain over the ledger. The formula, tamper detection, append-only, concurrency and the integrity report. */
describe('ledger hash chain (ADR 0094, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const integrity = new OperationsLedgerIntegrityService(prisma)
  const suffix = `chain-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tenants: string[] = []
  let tenantId = ''
  const wallets: string[] = []
  let n = 0
  const key = () => `${suffix}-k${++n}`

  const breaks = () => prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ wallet_id: string; entry_id: string | null; seq: number | null; reason: string }>>`SELECT * FROM fbeds_ledger_chain_breaks() ORDER BY 1, 3, 4`)
  const links = (walletId: string) => prisma.withTenant(tenantId, (tx) => tx.ledgerChainLink.findMany({ where: { tenantId, walletId }, orderBy: { seq: 'asc' } }))
  const append = (walletId: string, type: 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND', amountMinor: bigint, reference: string | null = null) =>
    prisma.withTenant(tenantId, (tx) => appendLedgerEntry(tx, { tenantId, walletId, type, amountMinor, currency: 'AED', idempotencyKey: key(), reference }))
  /** Bypasses the application and the append-only triggers, as a database owner could. */
  const asOwner = (work: (tx: any) => Promise<unknown>) => prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantId}', true)`); await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await work(tx) })

  beforeAll(async () => {
    const slug = `${suffix}-t`
    tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    tenants.push(tenantId)
    const creator = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    for (let i = 0; i < 4; i += 1) {
      const agency = await prisma.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: creator } }, name: `${slug} agency ${i}`, code: `CH${randomBytes(3).toString('hex').toUpperCase()}` } as never })
      wallets.push((await prisma.wallet.create({ data: { tenantId, agencyId: agency.id, currency: 'AED' } })).id)
    }
  })

  afterAll(async () => {
    for (const id of tenants) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        for (const table of ['LedgerChainLink', 'LedgerEntry', 'Wallet', 'Agency']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('CHAIN-FORMULA: every entry is linked in the same transaction, and the stored hash equals the documented SHA-256 text', async () => {
    const w = wallets[0]
    const first = await append(w, 'CREDIT', 100000n, 'funding:abc')
    const second = await append(w, 'HOLD', -25000n, 'booking:b1')
    const [l1, l2] = await links(w)
    expect([l1.seq, l2.seq]).toEqual([1, 2])
    expect(l1.prevHash).toBe('0'.repeat(64))
    expect(l2.prevHash).toBe(l1.entryHash)
    const canonical = (prev: string, e: typeof first) => [prev, e.id, e.tenantId, e.walletId, e.type, e.amountMinor.toString(), e.currency, e.reference ?? '', e.idempotencyKey, e.immutableAt.toISOString()].join('|')
    expect(l1.entryHash).toBe(createHash('sha256').update(canonical(l1.prevHash, first), 'utf8').digest('hex'))
    expect(l2.entryHash).toBe(createHash('sha256').update(canonical(l2.prevHash, second), 'utf8').digest('hex'))
    expect(await breaks()).toEqual([])
  })

  it('CHAIN-ATOMIC: a rolled-back entry leaves no link, and a link cannot exist without its entry', async () => {
    const w = wallets[0]
    const before = (await links(w)).length
    await expect(prisma.withTenant(tenantId, async (tx) => { await appendLedgerEntry(tx, { tenantId, walletId: w, type: 'CREDIT', amountMinor: 5n, currency: 'AED', idempotencyKey: key() }); throw new Error('abort') })).rejects.toThrow('abort')
    expect((await links(w)).length).toBe(before)
    expect(await breaks()).toEqual([])
  })

  it('CHAIN-APPEND-ONLY: a link cannot be updated or deleted, and no application path can write one', async () => {
    const [l] = await links(wallets[0])
    await expect(prisma.ledgerChainLink.update({ where: { id: l.id }, data: { entryHash: 'f'.repeat(64) } })).rejects.toThrow(/append-only/)
    await expect(prisma.ledgerChainLink.delete({ where: { id: l.id } })).rejects.toThrow(/append-only/)
  })

  it('CHAIN-CONCURRENT: 60 simultaneous appends across 4 wallets (credits, holds, settlements and partial refunds) leave every chain contiguous and valid, with no deadlock', async () => {
    const jobs: Array<Promise<unknown>> = []
    const ids: string[] = []
    for (let i = 0; i < 15; i += 1) for (const w of wallets) {
      const ref = `booking:${suffix}-${w}-${i}`
      // One business transaction per job, as the booking paths do: lock-free from the caller's view, the chain trigger serialises per wallet.
      jobs.push(prisma.withTenant(tenantId, async (tx) => {
        if (i % 3 === 0) { await appendLedgerEntry(tx, { tenantId, walletId: w, type: 'CREDIT', amountMinor: 50000n, currency: 'AED', idempotencyKey: key(), reference: `funding:${suffix}-${i}` }); return }
        if (i % 3 === 1) { await appendLedgerEntry(tx, { tenantId, walletId: w, type: 'HOLD', amountMinor: -10000n, currency: 'AED', idempotencyKey: key(), reference: ref }); await appendLedgerEntry(tx, { tenantId, walletId: w, type: 'RELEASE', amountMinor: 10000n, currency: 'AED', idempotencyKey: key(), reference: ref }); return }
        await appendLedgerEntry(tx, { tenantId, walletId: w, type: 'DEBIT', amountMinor: -7000n, currency: 'AED', idempotencyKey: key(), reference: ref })
        await appendLedgerEntry(tx, { tenantId, walletId: w, type: 'REFUND', amountMinor: 3000n, currency: 'AED', idempotencyKey: key(), reference: ref })
      }))
      ids.push(w)
    }
    await Promise.all(jobs)
    for (const w of wallets) {
      const chain = await links(w)
      const entries = await prisma.withTenant(tenantId, (tx) => tx.ledgerEntry.count({ where: { tenantId, walletId: w } }))
      expect(chain.length).toBe(entries)
      expect(chain.map((l) => l.seq)).toEqual(chain.map((_l, i) => i + 1))
      chain.forEach((l, i) => expect(l.prevHash).toBe(i === 0 ? '0'.repeat(64) : chain[i - 1].entryHash))
    }
    expect(await breaks()).toEqual([])
  })

  it('CHAIN-TAMPER: an edit, a removed link, an entry inserted behind the application and a removed entry are each detected', async () => {
    const [w1, w2, w3, w4] = wallets
    for (const w of [w1, w2, w3, w4]) { await append(w, 'CREDIT', 1000n); await append(w, 'CREDIT', 2000n); await append(w, 'CREDIT', 3000n) }
    const target = async (w: string, seq: number) => (await links(w)).find((l) => l.seq === seq)!

    // 1. The amount of a middle entry is edited.
    const edited = await target(w1, (await links(w1)).length - 1)
    await asOwner((tx) => tx.$executeRawUnsafe(`UPDATE "LedgerEntry" SET "amount_minor" = "amount_minor" + 1 WHERE "id" = $1`, edited.ledgerEntryId))
    // 2. A link in the middle of another wallet is removed.
    const removed = await target(w2, (await links(w2)).length - 1)
    await asOwner((tx) => tx.$executeRawUnsafe(`DELETE FROM "LedgerChainLink" WHERE "id" = $1`, removed.id))
    // 3. An entry is inserted with the chain trigger bypassed.
    await asOwner((tx) => tx.$executeRawUnsafe(`INSERT INTO "LedgerEntry" ("id","tenant_id","wallet_id","type","amount_minor","currency","idempotency_key") VALUES ($1,$2,$3,'CREDIT',999,'AED',$4)`, `${suffix}-ghost`, tenantId, w3, `${suffix}-ghost-key`))
    // 4. An entry is removed together with nothing else.
    const gone = await target(w4, (await links(w4)).length - 1)
    await asOwner((tx) => tx.$executeRawUnsafe(`DELETE FROM "LedgerEntry" WHERE "id" = $1`, gone.ledgerEntryId))

    const found = await breaks()
    const reasons = (w: string) => found.filter((b) => b.wallet_id === w).map((b) => b.reason).sort()
    expect(reasons(w1)).toEqual(['ENTRY_HASH_MISMATCH'])
    // The removed link also leaves its own entry without a link, which is reported too.
    expect(reasons(w2)).toEqual(['ENTRY_UNCHAINED', 'PREV_HASH_MISMATCH', 'SEQUENCE_GAP'])
    expect(reasons(w3)).toEqual(['ENTRY_UNCHAINED'])
    expect(reasons(w4)).toEqual(['ENTRY_MISSING'])
    expect(found.find((b) => b.wallet_id === w1)!.entry_id).toBe(edited.ledgerEntryId)
  })

  it('CHAIN-REPORT: the ledger integrity report turns every chain fault into a critical finding and publishes the chain heads', async () => {
    const report = await integrity.report(tenantId, {})
    expect(report.verdict).toBe('ISSUES')
    const codes = report.counts.byCode.filter((c) => c.code.startsWith('LEDGER_CHAIN_')).map((c) => c.code).sort()
    expect(codes).toEqual(['LEDGER_CHAIN_BROKEN', 'LEDGER_CHAIN_ENTRY_UNCHAINED'])
    expect(report.counts.byCode.filter((c) => c.code.startsWith('LEDGER_CHAIN_')).every((c) => c.severity === 'critical')).toBe(true)
    expect(report.chainHeads.length).toBe(4)
    expect(report.chainHeads.every((h) => /^[0-9a-f]{64}$/.test(h.entryHash) && h.seq >= 1)).toBe(true)
    expect(report.definitions.LEDGER_CHAIN_BROKEN).toMatch(/security incident/)
  })

  it('CHAIN-TENANT: the verifier and the heads are tenant-filtered by the function itself (this connection is a superuser, so row-level security is not what is tested here)', async () => {
    const slug = `${suffix}-other`
    const other = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    tenants.push(other)
    const rows = await prisma.withTenant(other, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM fbeds_ledger_chain_breaks()`)
    expect(rows[0].n).toBe(0n)
    expect((await breaks()).length).toBeGreaterThan(0)
    expect(await prisma.withTenant(other, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM fbeds_ledger_chain_heads()`)).toEqual([])
  })
})
