import { randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { CreditNoteService } from '../src/finance-credit-notes/credit-note.service'
import { OperationsLedgerIntegrityService } from '../src/admin-operations/operations-ledger-integrity.service'

jest.setTimeout(120_000)

/** ADR 0095 part B on PostgreSQL: partial credit notes, maker-checker, one REFUND per approval, never more than the charge, concurrency, and a clean ledger afterwards. */
describe('booking credit notes (ADR 0095 part B, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const service = new CreditNoteService(prisma)
  const integrity = new OperationsLedgerIntegrityService(prisma)
  const suffix = `cn-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tenants: string[] = []
  let tenantId = '', walletId = '', alice = '', bob = '', carol = ''
  let n = 0
  const rid = () => `${suffix}-req-${++n}`

  /** A booking charged on the ledger exactly as the booking paths do: HOLD, then the settle RELEASE and DEBIT. */
  async function booking(tag: string, total: bigint, status: 'CONFIRMED' | 'CANCELLED' | 'CHECKED_OUT' = 'CONFIRMED', charged = true) {
    const b = await prisma.booking.create({ data: { tenantId, reference: `${suffix}-${tag}`.toUpperCase(), supplier: 'fixture', hotelId: 'fixture-hotel', status, currency: 'AED', totalMinor: total, idempotencyKey: `${suffix}-${tag}-${++n}`, searchSnapshot: {} } })
    if (charged) {
      const ref = `booking:${b.id}`, key = `booking:${b.id}:authorize`
      const at = (type: 'HOLD' | 'RELEASE' | 'DEBIT', amountMinor: bigint, k: string) => prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor, currency: 'AED', reference: ref, idempotencyKey: k } })
      await at('HOLD', -total, key); await at('RELEASE', total, `${key}:settle-release`); await at('DEBIT', -total, `${key}:settle-debit`)
    }
    return b
  }
  const body = (bookingId: string, amountMinor: string, over: Record<string, unknown> = {}) => ({ requestId: rid(), bookingId, amountMinor, reason: 'SUPPLIER_SERVICE_FAILURE', note: 'Hotel relocated the guests to a lower category', ...over })
  const refunds = (bookingId: string) => prisma.ledgerEntry.findMany({ where: { tenantId, type: 'REFUND', reference: `booking:${bookingId}` } })
  const withFlag = async (value: string | undefined, work: () => Promise<void>) => {
    const before = process.env.CREDIT_NOTES_ENABLED
    if (value === undefined) delete process.env.CREDIT_NOTES_ENABLED; else process.env.CREDIT_NOTES_ENABLED = value
    try { await work() } finally { if (before === undefined) delete process.env.CREDIT_NOTES_ENABLED; else process.env.CREDIT_NOTES_ENABLED = before }
  }

  beforeAll(async () => {
    process.env.CREDIT_NOTES_ENABLED = 'true'
    const slug = `${suffix}-t`
    tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    tenants.push(tenantId)
    const user = async (name: string) => (await prisma.user.create({ data: { email: `${suffix}-${name}@example.test` } })).id
    alice = await user('alice'); bob = await user('bob'); carol = await user('carol')
    const agency = await prisma.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: alice } }, name: `${slug} agency`, code: `CN${randomBytes(3).toString('hex').toUpperCase()}` } as never })
    walletId = (await prisma.wallet.create({ data: { tenantId, agencyId: agency.id, currency: 'AED' } })).id
    await prisma.ledgerEntry.create({ data: { tenantId, walletId, type: 'CREDIT', amountMinor: 5_000_000n, currency: 'AED', reference: `funding:${suffix}`, idempotencyKey: `${suffix}-fund` } })
  })

  afterAll(async () => {
    for (const id of tenants) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        for (const table of ['BookingCreditNote', 'LedgerChainLink', 'LedgerEntry', 'Wallet', 'Booking', 'AuditEvent', 'Agency']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('NOTE-FLAG: with the flag unset every write answers 503 and nothing is stored', async () => {
    const b = await booking('flag', 10000n)
    await withFlag(undefined, async () => {
      await expect(service.propose(tenantId, alice, body(b.id, '100'))).rejects.toMatchObject({ response: { code: 'CREDIT_NOTES_DISABLED' } })
      await expect(service.approve(tenantId, bob, 'x')).rejects.toMatchObject({ response: { code: 'CREDIT_NOTES_DISABLED' } })
    })
    expect(await prisma.bookingCreditNote.count({ where: { tenantId } })).toBe(0)
  })

  it('NOTE-FLOW: propose moves no money; a different person approves; exactly one REFUND is posted; numbering, audit and the ledger tie out', async () => {
    const b = await booking('flow', 100000n)
    const proposed = await service.propose(tenantId, alice, body(b.id, '25000'))
    expect(proposed).toMatchObject({ status: 'PROPOSED', number: `CN-${b.reference}-P1`, amountMinor: '25000', currency: 'AED', bookingReference: b.reference, canDecide: false })
    expect(await refunds(b.id)).toHaveLength(0)
    expect((await service.list(tenantId, bob, { bookingId: b.id })).items[0]).toMatchObject({ id: proposed.id, canDecide: true })

    const approved = await service.approve(tenantId, bob, proposed.id)
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: bob })
    const posted = await refunds(b.id)
    expect(posted.map((e) => [e.amountMinor, e.idempotencyKey, e.id])).toEqual([[25000n, `booking:${b.id}:credit-note:${proposed.id}`, approved.ledgerEntryId]])
    for (const action of ['finance.credit_note.proposed', 'finance.credit_note.approved']) expect(await prisma.auditEvent.count({ where: { tenantId, action, entityId: proposed.id } })).toBe(1)
    // On this booking's reference: HOLD -100000, settle RELEASE +100000, DEBIT -100000, REFUND +25000. The credit cuts what the agency owes for it by exactly 25000.
    expect((await prisma.ledgerEntry.aggregate({ where: { tenantId, walletId, reference: `booking:${b.id}` }, _sum: { amountMinor: true } }))._sum.amountMinor).toBe(-75000n)
    // Replays: the same request returns the same note; a second approval is refused and posts nothing more.
    await expect(service.approve(tenantId, carol, proposed.id)).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_DECIDED' } })
    expect(await refunds(b.id)).toHaveLength(1)
  })

  it('NOTE-IDEMPOTENT: the same requestId returns the same note; reuse for another booking or amount is refused', async () => {
    const b = await booking('idem', 50000n)
    const input = body(b.id, '1000')
    const first = await service.propose(tenantId, alice, input)
    expect((await service.propose(tenantId, alice, input)).id).toBe(first.id)
    await expect(service.propose(tenantId, alice, { ...input, amountMinor: '2000' })).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_REQUEST_REUSED' } })
    expect(await prisma.bookingCreditNote.count({ where: { tenantId, bookingId: b.id } })).toBe(1)
  })

  it('NOTE-SEPARATION: the proposer can neither approve nor reject their own note, and a rejection needs a reason and posts nothing', async () => {
    const b = await booking('sep', 40000n)
    const note = await service.propose(tenantId, alice, body(b.id, '5000'))
    await expect(service.approve(tenantId, alice, note.id)).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_OWN_PROPOSAL' } })
    await expect(service.reject(tenantId, alice, note.id, { reason: 'changed my mind' })).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_OWN_PROPOSAL' } })
    await expect(service.reject(tenantId, bob, note.id, {})).rejects.toMatchObject({ status: 400 })
    const rejected = await service.reject(tenantId, bob, note.id, { reason: 'Supplier confirmed no service failure' })
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionReason: 'Supplier confirmed no service failure', ledgerEntryId: null })
    expect(await refunds(b.id)).toHaveLength(0)
    await expect(service.approve(tenantId, bob, note.id)).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_DECIDED' } })
    await expect(prisma.bookingCreditNote.update({ where: { id: note.id }, data: { amountMinor: 1n } })).rejects.toThrow(/immutable/)
    await expect(prisma.bookingCreditNote.delete({ where: { id: note.id } })).rejects.toThrow(/never deleted/)
  })

  it('NOTE-LIMITS: never more than the charge not yet refunded, counting notes still waiting; cancelled, uncharged and unknown bookings are refused', async () => {
    const b = await booking('limit', 10000n)
    await service.propose(tenantId, alice, body(b.id, '6000'))
    await expect(service.propose(tenantId, alice, body(b.id, '4001'))).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_EXCEEDS_REFUNDABLE' } })
    const second = await service.propose(tenantId, alice, body(b.id, '4000'))
    expect(second.number).toBe(`CN-${b.reference}-P2`)
    await expect(service.propose(tenantId, alice, body(b.id, '1'))).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_EXCEEDS_REFUNDABLE' } })
    const cancelled = await booking('cancelled', 10000n, 'CANCELLED')
    await expect(service.propose(tenantId, alice, body(cancelled.id, '100'))).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_BOOKING_STATE' } })
    const manual = await booking('manual', 10000n, 'CONFIRMED', false)
    await expect(service.propose(tenantId, alice, body(manual.id, '100'))).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_NOT_LEDGER_CHARGED' } })
    await expect(service.propose(tenantId, alice, body('no-such-booking', '100'))).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_BOOKING_NOT_FOUND' } })
  })

  it('NOTE-REFUND-CHANGED: a refund posted between proposal and approval stops an approval that would now exceed the charge', async () => {
    const b = await booking('changed', 10000n)
    const note = await service.propose(tenantId, alice, body(b.id, '6000'))
    await prisma.ledgerEntry.create({ data: { tenantId, walletId, type: 'REFUND', amountMinor: 5000n, currency: 'AED', reference: `booking:${b.id}`, idempotencyKey: `${suffix}-other-refund` } })
    await expect(service.approve(tenantId, bob, note.id)).rejects.toMatchObject({ response: { code: 'CREDIT_NOTE_EXCEEDS_REFUNDABLE' } })
    expect(await prisma.bookingCreditNote.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ status: 'PROPOSED', ledgerEntryId: null })
  })

  it('NOTE-CONCURRENT: simultaneous proposals never over-credit, and simultaneous approvals post at most the charge, each note exactly once', async () => {
    const b = await booking('race', 10000n)
    const proposals = await Promise.allSettled(Array.from({ length: 8 }, () => service.propose(tenantId, alice, body(b.id, '2000'))))
    const accepted = proposals.filter((p): p is PromiseFulfilledResult<Awaited<ReturnType<typeof service.propose>>> => p.status === 'fulfilled').map((p) => p.value)
    expect(accepted).toHaveLength(5) // 5 x 2000 = the 10000 charge; the other three are refused
    expect(proposals.filter((p) => p.status === 'rejected').every((p) => (p as PromiseRejectedResult).reason.response?.code === 'CREDIT_NOTE_EXCEEDS_REFUNDABLE')).toBe(true)
    expect(new Set(accepted.map((a) => a.number)).size).toBe(5)

    // Approve every note twice at once from two approvers: each posts once.
    await Promise.allSettled(accepted.flatMap((a) => [service.approve(tenantId, bob, a.id), service.approve(tenantId, carol, a.id)]))
    const posted = await refunds(b.id)
    expect(posted).toHaveLength(5)
    expect(posted.reduce((sum, e) => sum + e.amountMinor, 0n)).toBe(10000n)
    expect(new Set(posted.map((e) => e.idempotencyKey)).size).toBe(5)
    expect((await prisma.bookingCreditNote.findMany({ where: { tenantId, bookingId: b.id } })).every((x) => x.status === 'APPROVED' && x.ledgerEntryId !== null)).toBe(true)
  })

  it('NOTE-LEDGER: after all of it the ledger integrity report has no credit-note faults and the hash chain still verifies', async () => {
    const report = await integrity.report(tenantId, {})
    const codes = report.counts.byCode.map((c) => c.code)
    expect(codes).not.toContain('REFUND_EXCEEDS_CHARGE')
    expect(codes.filter((c) => c.startsWith('LEDGER_CHAIN_'))).toEqual([])
    expect(report.chainHeads.length).toBe(1)
  })
})
