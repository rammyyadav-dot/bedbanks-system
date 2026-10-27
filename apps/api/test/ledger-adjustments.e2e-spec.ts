import { randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { LedgerAdjustmentService } from '../src/finance-adjustments/ledger-adjustment.service'
import { OperationsLedgerIntegrityService } from '../src/admin-operations/operations-ledger-integrity.service'

jest.setTimeout(120_000)

/** ADR 0100 on PostgreSQL: ADJUSTMENT and REVERSAL entries, maker-checker, one entry per approval, reversals capped by their receipt, database guards, concurrency, and the integrity report. */
describe('ledger adjustments and reversals (ADR 0100, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const service = new LedgerAdjustmentService(prisma)
  const integrity = new OperationsLedgerIntegrityService(prisma)
  const suffix = `la-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tenants: string[] = []
  let tenantId = '', walletId = '', agencyId = '', otherAgencyId = '', alice = '', bob = '', carol = ''
  let n = 0
  const rid = () => `${suffix}-req-${++n}`

  /** A POSTED funding receipt exactly as the funding post leaves it: the receipt, its CREDIT `funding:<id>`, and the links between them. */
  async function receipt(tag: string, amountMinor: bigint, over: { agency?: string; wallet?: string; status?: 'POSTED' | 'DECLARED'; currency?: string } = {}) {
    const id = `${suffix}-${tag}-${++n}`
    const agency = over.agency ?? agencyId, wallet = over.wallet ?? walletId, currency = over.currency ?? 'AED'
    const base = { id, tenantId, agencyId: agency, currency, amountMinor, method: 'BANK_TRANSFER' as const, bankReference: `${id}-bank`, valueDate: new Date('2026-10-01'), payerName: 'Fixture payer', payerType: 'AGENCY' as const,
      complianceReviewRequired: false, secondApprovalRequired: false, channel: 'ADMIN' as const, requestId: `${id}-req`, declaredById: alice }
    if (over.status === 'DECLARED') return prisma.fundingReceipt.create({ data: { ...base, status: 'DECLARED' } })
    const entry = await prisma.ledgerEntry.create({ data: { tenantId, walletId: wallet, type: 'CREDIT', amountMinor, currency, reference: `funding:${id}`, idempotencyKey: `funding:${id}` } })
    return prisma.fundingReceipt.create({ data: { ...base, status: 'POSTED', verifiedById: bob, verifiedAt: new Date(), postedById: carol, postedAt: new Date(), walletId: wallet, ledgerEntryId: entry.id } })
  }
  const adjust = (over: Record<string, unknown> = {}) => ({ requestId: rid(), kind: 'ADJUSTMENT', agencyId, currency: 'AED', direction: 'DEBIT', amountMinor: '2500', reason: 'BANK_FEE', note: 'Incoming transfer fee charged by our bank', ...over })
  const reverse = (receiptId: string, amountMinor: string, over: Record<string, unknown> = {}) => ({ requestId: rid(), kind: 'REVERSAL', agencyId, currency: 'AED', amountMinor, reason: 'PAYMENT_RECALL', note: 'Bank recalled the transfer', fundingReceiptId: receiptId, ...over })
  const entries = (type: 'ADJUSTMENT' | 'REVERSAL', walletFilter = walletId) => prisma.ledgerEntry.findMany({ where: { tenantId, walletId: walletFilter, type }, orderBy: { immutableAt: 'asc' } })
  const balance = async () => (await prisma.ledgerEntry.aggregate({ where: { tenantId, walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
  const withFlag = async (value: string | undefined, work: () => Promise<void>) => {
    const before = process.env.LEDGER_ADJUSTMENTS_ENABLED
    if (value === undefined) delete process.env.LEDGER_ADJUSTMENTS_ENABLED; else process.env.LEDGER_ADJUSTMENTS_ENABLED = value
    try { await work() } finally { if (before === undefined) delete process.env.LEDGER_ADJUSTMENTS_ENABLED; else process.env.LEDGER_ADJUSTMENTS_ENABLED = before }
  }

  beforeAll(async () => {
    process.env.LEDGER_ADJUSTMENTS_ENABLED = 'true'
    const slug = `${suffix}-t`
    tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    tenants.push(tenantId)
    const user = async (name: string) => (await prisma.user.create({ data: { email: `${suffix}-${name}@example.test` } })).id
    alice = await user('alice'); bob = await user('bob'); carol = await user('carol')
    const agency = async (tag: string) => (await prisma.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: alice } }, name: `${slug} ${tag}`, code: `LA${randomBytes(3).toString('hex').toUpperCase()}` } as never })).id
    agencyId = await agency('main'); otherAgencyId = await agency('other')
    walletId = (await prisma.wallet.create({ data: { tenantId, agencyId, currency: 'AED' } })).id
  })

  afterAll(async () => {
    for (const id of tenants) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        for (const table of ['LedgerAdjustment', 'FundingReceipt', 'LedgerChainLink', 'LedgerEntry', 'Wallet', 'AuditEvent', 'Agency']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('ADJ-FLAG: with the flag unset every write answers 503 and nothing is stored', async () => {
    await withFlag(undefined, async () => {
      await expect(service.propose(tenantId, alice, adjust())).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENTS_DISABLED' } })
      await expect(service.approve(tenantId, bob, 'x')).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENTS_DISABLED' } })
      await expect(service.reject(tenantId, bob, 'x', { reason: 'nope nope' })).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENTS_DISABLED' } })
    })
    expect(await prisma.ledgerAdjustment.count({ where: { tenantId } })).toBe(0)
  })

  it('ADJ-FLOW: propose moves no money; a different person approves; exactly one ADJUSTMENT is posted with the signed amount; audit and idempotency hold', async () => {
    await receipt('seed', 1_000_000n)
    const before = await balance()
    const proposed = await service.propose(tenantId, alice, adjust())
    expect(proposed).toMatchObject({ status: 'PROPOSED', kind: 'ADJUSTMENT', direction: 'DEBIT', amountMinor: '2500', currency: 'AED', canDecide: false, ledgerEntryId: null })
    expect(await entries('ADJUSTMENT')).toHaveLength(0)
    expect(await balance()).toBe(before)
    expect((await service.list(tenantId, bob, { agencyId })).items[0]).toMatchObject({ id: proposed.id, canDecide: true })

    const approved = await service.approve(tenantId, bob, proposed.id)
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: bob })
    const posted = await entries('ADJUSTMENT')
    expect(posted.map((e) => [e.amountMinor, e.idempotencyKey, e.reference, e.id])).toEqual([[-2500n, `adjustment:${proposed.id}`, `adjustment:${proposed.id}`, approved.ledgerEntryId]])
    expect(await balance()).toBe(before - 2500n)
    for (const action of ['finance.ledger_adjustment.proposed', 'finance.ledger_adjustment.approved']) expect(await prisma.auditEvent.count({ where: { tenantId, action, entityId: proposed.id } })).toBe(1)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'finance.ledger_adjustment.approved', entityId: proposed.id } })
    expect(audit.payload).toMatchObject({ kind: 'ADJUSTMENT', direction: 'DEBIT', amountMinor: '2500', ledgerEntryId: approved.ledgerEntryId, balanceAfterMinor: (before - 2500n).toString() })
    await expect(service.approve(tenantId, carol, proposed.id)).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_DECIDED' } })
    expect(await entries('ADJUSTMENT')).toHaveLength(1)
  })

  it('ADJ-CREDIT: a credit adjustment is stored positive', async () => {
    const before = await balance()
    const proposed = await service.propose(tenantId, alice, adjust({ direction: 'CREDIT', amountMinor: '700', reason: 'UNIDENTIFIED_CREDIT_ALLOCATED', note: 'Suspense credit allocated to this agency' }))
    const approved = await service.approve(tenantId, bob, proposed.id)
    expect(approved).toMatchObject({ direction: 'CREDIT', amountMinor: '700' })
    expect(await balance()).toBe(before + 700n)
  })

  it('ADJ-IDEMPOTENT: the same requestId returns the same proposal; reuse for another amount, agency or reason is refused', async () => {
    const input = adjust({ amountMinor: '111' })
    const first = await service.propose(tenantId, alice, input)
    expect((await service.propose(tenantId, alice, input)).id).toBe(first.id)
    await expect(service.propose(tenantId, alice, { ...input, amountMinor: '222' })).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_REQUEST_REUSED' } })
    await expect(service.propose(tenantId, alice, { ...input, reason: 'CORRECTION' })).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_REQUEST_REUSED' } })
    expect(await prisma.ledgerAdjustment.count({ where: { tenantId, requestId: input.requestId } })).toBe(1)
  })

  it('ADJ-SEPARATION: the proposer can neither approve nor reject; a rejection needs a reason, posts nothing and the decided row is immutable', async () => {
    const note = await service.propose(tenantId, alice, adjust({ amountMinor: '333' }))
    await expect(service.approve(tenantId, alice, note.id)).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_OWN_PROPOSAL' } })
    await expect(service.reject(tenantId, alice, note.id, { reason: 'changed my mind' })).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_OWN_PROPOSAL' } })
    await expect(service.reject(tenantId, bob, note.id, {})).rejects.toMatchObject({ status: 400 })
    const before = await balance()
    const rejected = await service.reject(tenantId, bob, note.id, { reason: 'Bank advice shows no such fee' })
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionReason: 'Bank advice shows no such fee', ledgerEntryId: null })
    expect(await balance()).toBe(before)
    await expect(service.approve(tenantId, bob, note.id)).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_DECIDED' } })
    await expect(prisma.ledgerAdjustment.update({ where: { id: note.id }, data: { amountMinor: -1n } })).rejects.toThrow(/immutable/)
    await expect(prisma.ledgerAdjustment.delete({ where: { id: note.id } })).rejects.toThrow(/never deleted/)
  })

  it('ADJ-REVERSAL: a reversal takes back part of a posted receipt, is stored negative against the receipt reference, and never exceeds what the receipt paid', async () => {
    const r = await receipt('rev', 100_000n)
    const before = await balance()
    const first = await service.propose(tenantId, alice, reverse(r.id, '30000'))
    expect(first).toMatchObject({ kind: 'REVERSAL', direction: 'DEBIT', amountMinor: '30000', fundingReceiptId: r.id, reason: 'PAYMENT_RECALL' })
    const approved = await service.approve(tenantId, bob, first.id)
    const posted = await entries('REVERSAL')
    const mine = posted.filter((e) => e.reference === `funding:${r.id}`)
    expect(mine.map((e) => [e.amountMinor, e.idempotencyKey, e.id])).toEqual([[-30000n, `funding:${r.id}:reversal:${first.id}`, approved.ledgerEntryId]])
    expect(await balance()).toBe(before - 30000n)

    await expect(service.propose(tenantId, alice, reverse(r.id, '70001'))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_EXCEEDS_RECEIPT' } })
    const rest = await service.propose(tenantId, alice, reverse(r.id, '70000', { reason: 'CHARGEBACK' }))
    await expect(service.propose(tenantId, alice, reverse(r.id, '1'))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_EXCEEDS_RECEIPT' } })
    await service.approve(tenantId, bob, rest.id)
    expect((await entries('REVERSAL')).filter((e) => e.reference === `funding:${r.id}`).reduce((sum, e) => sum + e.amountMinor, 0n)).toBe(-100_000n)
  })

  it('ADJ-RECEIPT-RULES: only a posted receipt of this agency and currency can be reversed; unknown agency, receipt and account are refused', async () => {
    const declared = await receipt('declared', 5_000n, { status: 'DECLARED' })
    await expect(service.propose(tenantId, alice, reverse(declared.id, '100'))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_RECEIPT_NOT_POSTED' } })
    const posted = await receipt('mine', 5_000n)
    await expect(service.propose(tenantId, alice, reverse(posted.id, '100', { agencyId: otherAgencyId }))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_NO_ACCOUNT' } })
    await (prisma.wallet.create({ data: { tenantId, agencyId: otherAgencyId, currency: 'AED' } }))
    await expect(service.propose(tenantId, alice, reverse(posted.id, '100', { agencyId: otherAgencyId }))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_RECEIPT_MISMATCH' } })
    await expect(service.propose(tenantId, alice, reverse(posted.id, '100', { currency: 'USD' }))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_NO_ACCOUNT' } })
    await expect(service.propose(tenantId, alice, reverse('no-such-receipt', '100'))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_RECEIPT_NOT_FOUND' } })
    await expect(service.propose(tenantId, alice, adjust({ agencyId: 'no-such-agency' }))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_AGENCY_NOT_FOUND' } })
  })

  it('ADJ-DB-GUARDS: the database refuses a wrong sign, a zero amount, a cross-account record and a reversal without a receipt, for any role', async () => {
    const entry = (type: 'ADJUSTMENT' | 'REVERSAL', amountMinor: bigint, key: string) => prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor, currency: 'AED', reference: key, idempotencyKey: `${suffix}-${key}` } })
    await expect(entry('REVERSAL', 5n, 'rev-positive')).rejects.toThrow(/LedgerEntry_sign_by_type/)
    await expect(entry('ADJUSTMENT', 0n, 'adj-zero')).rejects.toThrow(/LedgerEntry_sign_by_type/)
    const record = (data: Record<string, unknown>) => prisma.ledgerAdjustment.create({ data: { tenantId, agencyId, walletId, kind: 'ADJUSTMENT', currency: 'AED', amountMinor: -5n, reason: 'BANK_FEE', note: 'guard probe', requestId: rid(), proposedById: alice, ...data } as never })
    await expect(record({ kind: 'REVERSAL', reason: 'PAYMENT_RECALL' })).rejects.toThrow(/LedgerAdjustment_kind_facts/)
    await expect(record({ reason: 'CHARGEBACK' })).rejects.toThrow(/LedgerAdjustment_kind_facts/)
    await expect(record({ amountMinor: 0n })).rejects.toThrow(/LedgerAdjustment_amount_nonzero/)
    await expect(record({ currency: 'USD' })).rejects.toThrow(/currency differs|agency or currency/)
    await expect(record({ agencyId: otherAgencyId })).rejects.toThrow(/agency or currency/)
    const posted = await receipt('guard', 1_000n)
    await expect(record({ agencyId: otherAgencyId, walletId: (await prisma.wallet.findFirstOrThrow({ where: { tenantId, agencyId: otherAgencyId } })).id, kind: 'REVERSAL', reason: 'PAYMENT_RECALL', fundingReceiptId: posted.id })).rejects.toThrow(/receipt belongs to another/)
    // The proposer approving their own record is refused by the database; the probe runs in one transaction so it leaves no entry behind.
    const own = await record({})
    await expect(prisma.$transaction(async (tx) => {
      const e = await tx.ledgerEntry.create({ data: { tenantId, walletId, type: 'ADJUSTMENT', amountMinor: -1n, currency: 'AED', reference: 'self', idempotencyKey: `${suffix}-self` } })
      await tx.ledgerAdjustment.update({ where: { id: own.id }, data: { status: 'APPROVED', decidedById: alice, decidedAt: new Date(), ledgerEntryId: e.id } })
    })).rejects.toThrow(/LedgerAdjustment_second_person/)
  })

  it('ADJ-CONCURRENT: simultaneous reversal proposals never over-reverse a receipt, and simultaneous approvals post each reversal exactly once', async () => {
    const r = await receipt('race', 10_000n)
    const proposals = await Promise.allSettled(Array.from({ length: 8 }, () => service.propose(tenantId, alice, reverse(r.id, '2000'))))
    const accepted = proposals.filter((p): p is PromiseFulfilledResult<Awaited<ReturnType<typeof service.propose>>> => p.status === 'fulfilled').map((p) => p.value)
    expect(accepted).toHaveLength(5)
    expect(proposals.filter((p) => p.status === 'rejected').every((p) => (p as PromiseRejectedResult).reason.response?.code === 'LEDGER_ADJUSTMENT_EXCEEDS_RECEIPT')).toBe(true)

    await Promise.allSettled(accepted.flatMap((a) => [service.approve(tenantId, bob, a.id), service.approve(tenantId, carol, a.id)]))
    const posted = (await entries('REVERSAL')).filter((e) => e.reference === `funding:${r.id}`)
    expect(posted).toHaveLength(5)
    expect(posted.reduce((sum, e) => sum + e.amountMinor, 0n)).toBe(-10_000n)
    expect(new Set(posted.map((e) => e.idempotencyKey)).size).toBe(5)
    expect((await prisma.ledgerAdjustment.findMany({ where: { tenantId, fundingReceiptId: r.id } })).every((x) => x.status === 'APPROVED' && x.ledgerEntryId !== null)).toBe(true)
  })

  it('ADJ-APPROVAL-RECHECK: a reversal approved after another one consumed the receipt is refused, not posted', async () => {
    const r = await receipt('recheck', 1_000n)
    const first = await service.propose(tenantId, alice, reverse(r.id, '600'))
    // A second proposal cannot be made while the first waits (600 + 600 > 1000) ...
    await expect(service.propose(tenantId, alice, reverse(r.id, '600'))).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_EXCEEDS_RECEIPT' } })
    // ... so force one in the way a rejected-then-raced flow could: an approved reversal that appears under the proposal.
    await service.reject(tenantId, bob, first.id, { reason: 'Re-raising with another reason' })
    const a = await service.propose(tenantId, alice, reverse(r.id, '600'))
    await service.approve(tenantId, bob, a.id)
    const b = await prisma.ledgerAdjustment.create({ data: { tenantId, agencyId, walletId, kind: 'REVERSAL', currency: 'AED', amountMinor: -600n, reason: 'CHARGEBACK', note: 'forced behind the proposal check', fundingReceiptId: r.id, requestId: rid(), proposedById: alice } })
    await expect(service.approve(tenantId, bob, b.id)).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_EXCEEDS_RECEIPT' } })
    expect(await prisma.ledgerAdjustment.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'PROPOSED', ledgerEntryId: null })
  })

  it('ADJ-LEDGER: the integrity report ties adjustments and reversals out; an entry posted around the flow is a critical finding; the chain still verifies', async () => {
    let report = await integrity.report(tenantId, {})
    expect(report.counts.byCode.map((c) => c.code).filter((c) => c === 'ADJUSTMENT_WITHOUT_APPROVAL' || c === 'REVERSAL_EXCEEDS_RECEIPT')).toEqual([])
    expect(report.verdict).not.toBe('ISSUES')
    expect(report.counts.byCode.map((c) => c.code).filter((c) => c.startsWith('LEDGER_CHAIN_'))).toEqual([])
    const aed = report.totals.find((t) => t.currency === 'AED')!
    const credits = BigInt(aed.fundingCreditsMinor) + BigInt(aed.otherCreditsMinor) + BigInt(aed.refundsMinor) - BigInt(aed.chargesMinor) - BigInt(aed.openReservationsMinor) + BigInt(aed.adjustmentsMinor) - BigInt(aed.reversalsMinor)
    expect(BigInt(aed.balanceMinor)).toBe(credits)
    expect(BigInt(aed.reversalsMinor)).toBeGreaterThan(0n)
    expect(BigInt(aed.postedReceiptsMinor)).toBe(BigInt(aed.fundingCreditsMinor))

    const rogue = await prisma.ledgerEntry.create({ data: { tenantId, walletId, type: 'ADJUSTMENT', amountMinor: 999n, currency: 'AED', reference: 'adjustment:rogue', idempotencyKey: `${suffix}-rogue` } })
    report = await integrity.report(tenantId, {})
    expect(report.verdict).toBe('ISSUES')
    expect(report.findings.find((f) => f.code === 'ADJUSTMENT_WITHOUT_APPROVAL')).toMatchObject({ severity: 'critical', entryId: rogue.id, accountId: walletId })
  })
})
