import { randomBytes } from 'crypto'
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { ReconciliationStore } from '../src/finance-reconciliation/reconciliation-store'
import { ReconciliationService } from '../src/finance-reconciliation/reconciliation.service'
import { ReconciliationRunner, STALE_CLAIM_MS } from '../src/finance-reconciliation/reconciliation-runner.service'
import { ReconciliationWorker } from '../src/finance-reconciliation/reconciliation-worker.service'

/** ADR 0070 on PostgreSQL: statement import, the matching run, the worker's claim, and the dispute queue's maker-checker. */
describe('supplier statement reconciliation (ADR 0070, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const store = new ReconciliationStore(prisma)
  const service = new ReconciliationService(store)
  const runner = new ReconciliationRunner(store)
  const suffix = `recon-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tenants: string[] = []
  let A: { tenantId: string; supplierId: string; alice: string; bob: string; carol: string }
  let B: { tenantId: string; supplierId: string; bob: string }
  let n = 0
  const rid = () => `${suffix}-req-${++n}`

  async function tenant(tag: string) {
    const key = `${suffix}-${tag}`
    const tenantId = (await prisma.tenant.create({ data: { name: key, slug: key } })).id
    tenants.push(tenantId)
    const supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${key} LLC`, displayName: `Supplier ${tag}`, countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const user = async (name: string) => (await prisma.user.create({ data: { email: `${key}-${name}@example.test` } })).id
    return { tenantId, supplierId, user }
  }

  const booking = async (t: { tenantId: string; supplierId: string }, ref: string, over: Record<string, unknown> = {}) => prisma.booking.create({ data: {
    tenantId: t.tenantId, supplierId: t.supplierId, reference: `${suffix}-${ref}`, supplier: 'S', hotelId: 'h1', status: 'CONFIRMED', currency: 'AED', totalMinor: 20000n, idempotencyKey: `${suffix}-${ref}`,
    searchSnapshot: {}, netMinor: 10000n, checkOut: new Date('2026-10-10T00:00:00Z'), ...over,
  } as never })

  const ref = (r: string) => `${suffix}-${r}`
  const statementBody = (over: Record<string, unknown> = {}) => ({
    supplierId: A.supplierId, statementRef: `INV-${suffix}-${++n}`, periodStart: '2026-10-01', periodEnd: '2026-10-31', requestId: rid(),
    lines: [{ reference: ref('BK1'), kind: 'CHARGE', currency: 'AED', amount: '100.00' }],
    ...over,
  })

  let bk: Record<string, { id: string }> = {}

  beforeAll(async () => {
    process.env.FINANCE_RECONCILIATION_ENABLED = 'true'
    const a = await tenant('a'); const b = await tenant('b')
    A = { tenantId: a.tenantId, supplierId: a.supplierId, alice: await a.user('alice'), bob: await a.user('bob'), carol: await a.user('carol') }
    B = { tenantId: b.tenantId, supplierId: b.supplierId, bob: await b.user('bob') }
    bk = {
      BK1: await booking(A, 'BK1', { supplierRef: `${suffix}-SUP-1` }),
      BK2: await booking(A, 'BK2'),
      BK3: await booking(A, 'BK3'),
      BK4: await booking(A, 'BK4'),
      BK5: await booking(A, 'BK5', { netMinor: null }),
      BK6: await booking(A, 'BK6', { status: 'CANCELLED', netMinor: 8000n }),
      BK7: await booking(A, 'BK7', { netMinor: 7000n }),
      BK8: await booking(A, 'BK8', { netMinor: 6000n, checkOut: new Date('2026-11-05T00:00:00Z') }),
    }
    await prisma.bookingFinanceEvent.create({ data: { tenantId: A.tenantId, bookingId: bk.BK6.id, type: 'CANCELLED', currency: 'AED', sellMinor: 20000n, netMinor: 8000n, penaltyMinor: 0n, refundMinor: 20000n } })
  })

  afterAll(async () => {
    for (const tenantId of tenants) {
      // Statements, lines and decisions are immutable by trigger; a disposable test tenant is removed with triggers off for this transaction only.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        for (const table of ['ReconciliationDecision', 'ReconciliationFinding', 'ReconciliationRun', 'SupplierStatementLine', 'SupplierStatement', 'BookingFinanceEvent', 'Booking', 'AuditEvent', 'Supplier']) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
        }
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', tenantId)
      })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  async function runStatement(body: Record<string, unknown>, tolerance?: string) {
    const statement = await service.importStatement(A.tenantId, A.alice, body as never)
    const run = await service.enqueueRun(A.tenantId, A.alice, statement.id, { requestId: rid(), ...(tolerance !== undefined && { roundingToleranceMinor: tolerance }) })
    expect(await runner.drain(A.tenantId)).toBeGreaterThanOrEqual(1)
    return { statement, run }
  }

  const findingsOf = (statementId: string) => prisma.reconciliationFinding.findMany({ where: { tenantId: A.tenantId, statementId }, orderBy: { findingKey: 'asc' } })

  it('RECON-FLAG: with the flag unset every write answers 503 and nothing is stored', async () => {
    delete process.env.FINANCE_RECONCILIATION_ENABLED
    try {
      await expect(service.importStatement(A.tenantId, A.alice, statementBody() as never)).rejects.toBeInstanceOf(ServiceUnavailableException)
      await expect(service.enqueueRun(A.tenantId, A.alice, 'x', { requestId: rid() })).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(await prisma.supplierStatement.count({ where: { tenantId: A.tenantId } })).toBe(0)
    } finally { process.env.FINANCE_RECONCILIATION_ENABLED = 'true' }
  })

  it('RECON-IMPORT: idempotent on requestId, refuses a reused id, a reused number, the same content under another number, and another tenant\'s supplier', async () => {
    const body = statementBody()
    const first = await service.importStatement(A.tenantId, A.alice, body as never)
    expect(first).toMatchObject({ lineCount: 1, supplier: { id: A.supplierId }, latestRun: null })
    expect((await service.importStatement(A.tenantId, A.alice, body as never)).id).toBe(first.id)
    await expect(service.importStatement(A.tenantId, A.alice, { ...body, statementRef: 'OTHER-REF-1' } as never)).rejects.toMatchObject({ response: { code: 'RECON_REQUEST_REUSED' } })
    await expect(service.importStatement(A.tenantId, A.alice, { ...body, statementRef: `DIFF-${suffix}`, requestId: rid() } as never)).rejects.toMatchObject({ response: { code: 'RECON_STATEMENT_DUPLICATE_CONTENT' } })
    await expect(service.importStatement(A.tenantId, A.alice, { ...body, requestId: rid(), lines: [{ reference: ref('BK1'), kind: 'CHARGE', currency: 'AED', amount: '100.01' }] } as never)).rejects.toMatchObject({ response: { code: 'RECON_STATEMENT_REF_EXISTS' } })
    await expect(service.importStatement(A.tenantId, A.alice, statementBody({ supplierId: B.supplierId }) as never)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.importStatement(A.tenantId, A.alice, statementBody({ lines: [{ reference: 'X', kind: 'CHARGE', currency: 'AED', amount: 1.5 }] }) as never)).rejects.toBeInstanceOf(BadRequestException)
    expect(await prisma.supplierStatementLine.count({ where: { tenantId: A.tenantId, statementId: first.id } })).toBe(1)
    expect(await prisma.auditEvent.count({ where: { tenantId: A.tenantId, action: 'finance.reconciliation.statement_imported', entityId: first.id } })).toBe(1)
  })

  it('RECON-IMMUTABLE: an imported statement and its lines cannot be edited or deleted, even by the owner role', async () => {
    const s = await service.importStatement(A.tenantId, A.alice, statementBody({ lines: [{ reference: ref('IMM'), kind: 'CHARGE', currency: 'AED', amount: '9.00' }] }) as never)
    await expect(prisma.supplierStatement.update({ where: { id: s.id }, data: { statementRef: 'tampered' } })).rejects.toThrow(/append-only/)
    await expect(prisma.supplierStatementLine.deleteMany({ where: { statementId: s.id } })).rejects.toThrow(/append-only/)
  })

  describe('the matching run', () => {
    let statementId: string
    const lines = [
      { reference: ref('BK1').toLowerCase(), kind: 'CHARGE', currency: 'AED', amount: '100.00' },      // exact on our reference, any case
      { reference: ref('BK2'), kind: 'CHARGE', currency: 'AED', amount: '105.00' },                    // overcharge
      { reference: ref('BK2'), kind: 'CHARGE', currency: 'AED', amount: '105.00' },                    // duplicate line
      { reference: ref('BK3'), kind: 'CHARGE', currency: 'AED', amount: '100.01' },                    // rounding variance at tolerance 1
      { reference: ref('BK4'), kind: 'CHARGE', currency: 'USD', amount: '27.23' },                     // currency mismatch, never converted
      { reference: ref('BK5'), kind: 'CHARGE', currency: 'AED', amount: '50.00' },                     // net unknown
      { reference: ref('BK6'), kind: 'CREDIT', currency: 'AED', amount: '80.00' },                     // expected credit of a free cancellation
      { reference: `${suffix}-SUP-1`.toLowerCase(), kind: 'SURCHARGE', currency: 'AED', amount: '15.00' }, // surcharge via the supplier's own reference
      { reference: ref('ZZZ9'), kind: 'CHARGE', currency: 'AED', amount: '20.00' },                    // unknown reference
    ]

    it('RECON-RUN: matches by reference and exact net; everything else becomes a typed exception; currencies are never converted', async () => {
      const { statement, run } = await runStatement(statementBody({ lines }), '1')
      statementId = statement.id
      expect(await prisma.reconciliationRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1, matchedCount: 2, exceptionCount: 8, errorCode: null })
      const rows = await findingsOf(statement.id)
      const byLine = Object.fromEntries((await prisma.supplierStatementLine.findMany({ where: { statementId: statement.id } })).map((l) => [l.lineNo, l.id]))
      const at = (lineNo: number) => rows.find((r) => r.lineId === byLine[lineNo])!
      expect(at(1)).toMatchObject({ type: 'MATCHED', status: 'RESOLVED', bookingId: bk.BK1.id, varianceMinor: 0n, isException: false })
      expect(at(2)).toMatchObject({ type: 'AMOUNT_OVERCHARGE', status: 'OPEN', statementMinor: 10500n, ledgerMinor: 10000n, varianceMinor: 500n })
      expect(at(3)).toMatchObject({ type: 'DUPLICATE_LINE', status: 'OPEN' })
      expect(at(4)).toMatchObject({ type: 'ROUNDING_VARIANCE', varianceMinor: 1n })
      expect(at(5)).toMatchObject({ type: 'CURRENCY_MISMATCH', currency: 'USD', statementMinor: 2723n, ledgerMinor: 10000n, varianceMinor: null })
      expect(at(6)).toMatchObject({ type: 'NET_UNKNOWN', ledgerMinor: null, varianceMinor: null })
      expect(at(7)).toMatchObject({ type: 'CREDIT_MATCHED', status: 'RESOLVED', bookingId: bk.BK6.id })
      expect(at(8)).toMatchObject({ type: 'UNINVOICED_SURCHARGE', bookingId: bk.BK1.id })
      expect(at(9)).toMatchObject({ type: 'UNMATCHED_LINE', bookingId: null })
      const gaps = rows.filter((r) => r.lineId === null)
      expect(gaps.map((g) => [g.type, g.bookingId])).toEqual([['MISSING_FROM_STATEMENT', bk.BK7.id]])
      expect(await prisma.auditEvent.count({ where: { tenantId: A.tenantId, action: 'finance.reconciliation.run_completed', entityId: run.id, actorType: 'USER', userId: A.alice } })).toBe(1)
      const detail = await service.getStatement(A.tenantId, statement.id)
      expect(detail.settlement.map((s) => [s.currency, s.chargesMinor, s.creditsMinor, s.statementNetMinor])).toEqual([['AED', '49501', '8000', '41501'], ['USD', '2723', '0', '2723']])
      expect(detail.statement.exceptions).toEqual({ open: 8, disputed: 0, pendingApproval: 0, resolved: 0 })
    })

    it('RECON-NOMONEY: the run wrote no ledger entry, wallet or booking change', async () => {
      expect(await prisma.ledgerEntry.count({ where: { tenantId: A.tenantId } })).toBe(0)
      expect(await prisma.wallet.count({ where: { tenantId: A.tenantId } })).toBe(0)
      expect((await prisma.booking.findUnique({ where: { id: bk.BK2.id } }))!.netMinor).toBe(10000n)
    })

    it('RECON-RERUN: a second run updates rather than duplicates, keeps a dispute, and closes a difference that disappeared', async () => {
      const exceptions = await service.listExceptions(A.tenantId, A.carol, { statementId, status: 'OPEN', pageSize: '100' })
      const overcharge = exceptions.items.find((e) => e.type === 'AMOUNT_OVERCHARGE')!
      await service.proposeDecision(A.tenantId, A.alice, overcharge.id, { action: 'KEEP_LEDGER_AND_DISPUTE', reason: 'Supplier invoiced above the contracted net' })
      const missing = exceptions.items.find((e) => e.type === 'MISSING_FROM_STATEMENT')!
      // The supplier's own booking BK5 gets its net recorded: its NET_UNKNOWN exception must close itself.
      await prisma.booking.update({ where: { id: bk.BK5.id }, data: { netMinor: 5000n } })
      const before = await prisma.reconciliationFinding.count({ where: { tenantId: A.tenantId, statementId } })
      await service.enqueueRun(A.tenantId, A.alice, statementId, { requestId: rid(), roundingToleranceMinor: '1' })
      await runner.drain(A.tenantId)
      expect(await prisma.reconciliationFinding.count({ where: { tenantId: A.tenantId, statementId } })).toBe(before)
      expect(await prisma.reconciliationFinding.findUnique({ where: { id: overcharge.id } })).toMatchObject({ status: 'DISPUTED', type: 'AMOUNT_OVERCHARGE' })
      expect(await prisma.reconciliationFinding.findUnique({ where: { id: missing.id } })).toMatchObject({ status: 'OPEN' })
      const net = (await findingsOf(statementId)).find((f) => f.type === 'MATCHED' && f.bookingId === bk.BK5.id)!
      expect(net).toMatchObject({ status: 'RESOLVED', resolution: 'AUTO_MATCHED', isException: false })
      expect(await prisma.reconciliationDecision.count({ where: { tenantId: A.tenantId, findingId: net.id, action: 'AUTO_RESOLVED', actorId: null } })).toBe(1)
    })

    it('RECON-QUEUE: only one active run per statement, and a requestId replays', async () => {
      const first = await service.enqueueRun(A.tenantId, A.alice, statementId, { requestId: `${suffix}-fixed-1` })
      expect((await service.enqueueRun(A.tenantId, A.alice, statementId, { requestId: `${suffix}-fixed-1` })).id).toBe(first.id)
      await expect(service.enqueueRun(A.tenantId, A.alice, statementId, { requestId: rid() })).rejects.toMatchObject({ response: { code: 'RECON_RUN_IN_PROGRESS' } })
      await expect(service.enqueueRun(A.tenantId, A.alice, statementId, { requestId: `${suffix}-fixed-1`, roundingToleranceMinor: '5' })).rejects.toMatchObject({ response: { code: 'RECON_REQUEST_REUSED' } })
      await expect(service.enqueueRun(A.tenantId, A.alice, statementId, { requestId: rid(), roundingToleranceMinor: '1001' })).rejects.toBeInstanceOf(BadRequestException)
      await expect(service.enqueueRun(B.tenantId, B.bob, statementId, { requestId: rid() })).rejects.toBeInstanceOf(NotFoundException)
      await runner.drain(A.tenantId)
      expect(await prisma.reconciliationRun.findUnique({ where: { id: first.id } })).toMatchObject({ status: 'SUCCEEDED' })
    })
  })

  describe('the worker', () => {
    it('RECON-CLAIM: two claimers cannot both win one run', async () => {
      const s = await service.importStatement(A.tenantId, A.alice, statementBody({ lines: [{ reference: ref('CL'), kind: 'CHARGE', currency: 'AED', amount: '1.00' }] }) as never)
      await service.enqueueRun(A.tenantId, A.alice, s.id, { requestId: rid() })
      const results = await Promise.all([runner.claimNext(A.tenantId), runner.claimNext(A.tenantId), runner.claimNext(A.tenantId)])
      expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1)
      await runner.drain(A.tenantId)
    })

    it('RECON-STALE: an abandoned claim is re-driven; after three attempts the run fails with a stable code', async () => {
      const s = await service.importStatement(A.tenantId, A.alice, statementBody({ lines: [{ reference: ref('ST'), kind: 'CHARGE', currency: 'AED', amount: '1.00' }] }) as never)
      const run = await service.enqueueRun(A.tenantId, A.alice, s.id, { requestId: rid() })
      const long = new Date(Date.now() - STALE_CLAIM_MS - 60_000)
      await prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: 'RUNNING', claimedAt: long, startedAt: long, attempts: 1 } })
      const reclaimed = await runner.claimNext(A.tenantId)
      expect(reclaimed.kind).toBe('claimed')
      expect(await prisma.reconciliationRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'RUNNING', attempts: 2 })
      await prisma.reconciliationRun.update({ where: { id: run.id }, data: { claimedAt: long, attempts: 3 } })
      expect((await runner.claimNext(A.tenantId)).kind).toBe('skipped')
      expect(await prisma.reconciliationRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'MAX_ATTEMPTS', finishedAt: expect.any(Date) })
    })

    it('RECON-WORKER: the pass discovers tenants through the definer function and drains their queue', async () => {
      const s = await service.importStatement(A.tenantId, A.alice, statementBody({ lines: [{ reference: ref('WK'), kind: 'CHARGE', currency: 'AED', amount: '1.00' }] }) as never)
      const run = await service.enqueueRun(A.tenantId, A.alice, s.id, { requestId: rid() })
      const worker = new ReconciliationWorker(store, runner, { FINANCE_RECONCILIATION_WORKER_ENABLED: 'true', FINANCE_RECONCILIATION_ENABLED: 'true' })
      expect(await worker.runOnce()).toBeGreaterThanOrEqual(1)
      expect(await prisma.reconciliationRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED' })
      expect(await worker.runOnce()).toBe(0)
    })
  })

  describe('the dispute queue', () => {
    let statementId: string
    let small: string
    let large: string
    beforeAll(async () => {
      await prisma.booking.update({ where: { id: bk.BK2.id }, data: { netMinor: 10000n } })
      const { statement } = await runStatement(statementBody({ lines: [
        { reference: ref('BK2'), kind: 'CHARGE', currency: 'AED', amount: '105.00' },   // variance 5.00: under the 100-unit threshold
        { reference: ref('BK3'), kind: 'CHARGE', currency: 'AED', amount: '400.00' },   // variance 300.00: needs a second person
      ] }))
      statementId = statement.id
      const items = (await service.listExceptions(A.tenantId, A.alice, { statementId, pageSize: '10' })).items
      small = items.find((i) => i.booking?.id === bk.BK2.id)!.id
      large = items.find((i) => i.booking?.id === bk.BK3.id)!.id
    })

    it('RECON-DECIDE-SMALL: a small variance resolves on the maker\'s own decision, with a decision row and an audit event, and never moves money', async () => {
      const detail = await service.proposeDecision(A.tenantId, A.alice, small, { action: 'ACCEPT_STATEMENT', reason: 'Supplier rate card changed, confirmed by email' })
      expect(detail.exception).toMatchObject({ status: 'RESOLVED', resolution: 'ACCEPT_STATEMENT', resolvedById: A.alice, canPropose: false })
      expect(detail.history.map((h) => [h.action, h.fromStatus, h.toStatus, h.actorId])).toEqual([['ACCEPT_STATEMENT', 'OPEN', 'RESOLVED', A.alice]])
      expect(await prisma.auditEvent.count({ where: { tenantId: A.tenantId, entityId: small, action: 'finance.reconciliation.exception_resolved' } })).toBe(1)
      await expect(service.proposeDecision(A.tenantId, A.bob, small, { action: 'ACCEPT_STATEMENT', reason: 'again' })).rejects.toMatchObject({ response: { code: 'RECON_ALREADY_RESOLVED' } })
      expect(await prisma.ledgerEntry.count({ where: { tenantId: A.tenantId } })).toBe(0)
    })

    it('RECON-DECIDE-LARGE: above the threshold the proposer cannot approve or reject; a different person can; the database enforces it too', async () => {
      const pending = await service.proposeDecision(A.tenantId, A.alice, large, { action: 'ACCEPT_STATEMENT', reason: 'Customer approved the higher rate in writing' })
      expect(pending.exception).toMatchObject({ status: 'PENDING_APPROVAL', proposedById: A.alice, resolution: null, canDecide: false })
      expect(pending.secondApprovalRequired.ACCEPT_STATEMENT).toBe(true)
      await expect(service.approveDecision(A.tenantId, A.alice, large, { reason: 'self approval' })).rejects.toBeInstanceOf(ForbiddenException)
      await expect(service.rejectDecision(A.tenantId, A.alice, large, { reason: 'self rejection' })).rejects.toBeInstanceOf(ForbiddenException)
      await expect(service.proposeDecision(A.tenantId, A.carol, large, { action: 'REJECT_STATEMENT_LINE', reason: 'competing proposal' })).rejects.toMatchObject({ response: { code: 'RECON_DECISION_PENDING' } })
      await expect(prisma.reconciliationFinding.update({ where: { id: large }, data: { status: 'RESOLVED', resolution: 'ACCEPT_STATEMENT', resolvedById: A.alice, resolvedAt: new Date() } })).rejects.toThrow(/second_person/)
      const sent = await service.rejectDecision(A.tenantId, A.bob, large, { reason: 'Need the written approval attached first' })
      expect(sent.exception).toMatchObject({ status: 'OPEN', proposedAction: null, proposedById: null })
      await service.proposeDecision(A.tenantId, A.alice, large, { action: 'ACCEPT_STATEMENT', reason: 'Written approval attached to the case' })
      const done = await service.approveDecision(A.tenantId, A.bob, large, { reason: 'Verified the attachment' })
      expect(done.exception).toMatchObject({ status: 'RESOLVED', resolution: 'ACCEPT_STATEMENT', proposedById: A.alice, resolvedById: A.bob })
      expect(done.history.map((h) => [h.action, h.toStatus, h.actorId])).toEqual([['ACCEPT_STATEMENT', 'PENDING_APPROVAL', A.alice], ['REJECTED', 'OPEN', A.bob], ['ACCEPT_STATEMENT', 'PENDING_APPROVAL', A.alice], ['APPROVED', 'RESOLVED', A.bob]])
    })

    it('RECON-DECIDE-GUARDS: an action the type does not offer, a short reason and a cross-tenant id are refused; the audit trail holds no free text', async () => {
      const { statement } = await runStatement(statementBody({ lines: [{ reference: ref('ZZ77'), kind: 'CHARGE', currency: 'AED', amount: '3.00' }] }))
      const item = (await service.listExceptions(A.tenantId, A.alice, { statementId: statement.id, type: 'UNMATCHED_LINE' })).items[0]
      expect(item).toMatchObject({ type: 'UNMATCHED_LINE', severity: 'MEDIUM', allowedActions: ['REJECT_STATEMENT_LINE', 'KEEP_LEDGER_AND_DISPUTE'] })
      await expect(service.proposeDecision(A.tenantId, A.alice, item.id, { action: 'WRITE_OFF_VARIANCE', reason: 'not offered here' })).rejects.toBeInstanceOf(BadRequestException)
      await expect(service.proposeDecision(A.tenantId, A.alice, item.id, { action: 'KEEP_LEDGER_AND_DISPUTE', reason: 'x' })).rejects.toBeInstanceOf(BadRequestException)
      await expect(service.getException(B.tenantId, B.bob, item.id)).rejects.toBeInstanceOf(NotFoundException)
      await expect(service.proposeDecision(B.tenantId, B.bob, item.id, { action: 'KEEP_LEDGER_AND_DISPUTE', reason: 'cross tenant' })).rejects.toBeInstanceOf(NotFoundException)
      await service.proposeDecision(A.tenantId, A.alice, item.id, { action: 'KEEP_LEDGER_AND_DISPUTE', reason: 'Contains the secret reason text' })
      const audit = await prisma.auditEvent.findFirst({ where: { tenantId: A.tenantId, entityId: item.id, action: 'finance.reconciliation.exception_disputed' } })
      expect(JSON.stringify(audit?.payload)).not.toContain('secret reason text')
      expect(audit?.payload).toMatchObject({ reasonLength: 'Contains the secret reason text'.length })
    })

    it('RECON-SUMMARY: counts by status and type, and the open variance per currency without adding currencies', async () => {
      const summary = await service.exceptionSummary(A.tenantId)
      expect(summary.byStatus.RESOLVED).toBeGreaterThanOrEqual(2)
      expect(summary.byStatus.DISPUTED).toBeGreaterThanOrEqual(1)
      const usd = summary.openVarianceByCurrency.find((r) => r.currency === 'USD')
      expect(usd).toMatchObject({ absoluteVarianceMinor: '0', unknownAmountCount: 1 })
      expect(summary.openVarianceByCurrency.map((r) => r.currency)).toEqual([...summary.openVarianceByCurrency.map((r) => r.currency)].sort())
      expect((await service.listExceptions(B.tenantId, B.bob, {})).total).toBe(0)
    })
  })
})
