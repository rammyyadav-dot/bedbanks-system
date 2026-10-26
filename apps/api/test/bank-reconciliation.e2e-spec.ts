import { randomBytes } from 'crypto'
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { ReconciliationStore } from '../src/finance-reconciliation/reconciliation-store'
import { BankReconciliationService } from '../src/finance-reconciliation/bank-reconciliation.service'

/** ADR 0093 on PostgreSQL: bank statement import, matching against settlements and funding receipts, immutability, idempotency and the exception queue. */
describe('bank statement reconciliation (ADR 0093, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const service = new BankReconciliationService(new ReconciliationStore(prisma))
  const suffix = `bank-${Date.now()}-${randomBytes(3).toString('hex')}`.toUpperCase()
  const tenants: string[] = []
  let A: { tenantId: string; supplierId: string; agencyId: string; alice: string; bob: string }
  let B: { tenantId: string; alice: string }
  let n = 0
  const rid = () => `${suffix}-req-${++n}`
  const sref = (tag: string) => `${suffix}-${tag}`

  async function tenant(tag: string) {
    const key = `${suffix.toLowerCase()}-${tag}`
    const tenantId = (await prisma.tenant.create({ data: { name: key, slug: key } })).id
    tenants.push(tenantId)
    const user = async (name: string) => (await prisma.user.create({ data: { email: `${key}-${name}@example.test` } })).id
    return { tenantId, user, key }
  }

  const mt940 = (stmt: string, account: string, lines: Array<{ dc: 'C' | 'D'; amount: string; ref: string }>, opening = '1000,00') => {
    const minor = (a: string) => { const [whole, fraction = ''] = a.split(','); return Number(whole) * 100 + Number(fraction.padEnd(2, '0')) }
    const closing = lines.reduce((sum, l) => sum + (l.dc === 'C' ? 1 : -1) * minor(l.amount), minor(opening))
    const closeText = `${Math.floor(Math.abs(closing) / 100)},${String(Math.abs(closing) % 100).padStart(2, '0')}`
    return [`:20:${stmt}`, `:25:${account}`, `:28C:1/1`, `:60F:C261001AED${opening}`,
      ...lines.flatMap((l) => [`:61:2610021002${l.dc}${l.amount}NTRFNONREF//${l.ref}`, `:86:${l.ref}`]),
      `:62F:${closing < 0 ? 'D' : 'C'}261003AED${closeText}`, '-'].join('\n')
  }

  beforeAll(async () => {
    process.env.FINANCE_RECONCILIATION_ENABLED = 'true'
    const a = await tenant('a'); const b = await tenant('b')
    const supplierId = (await prisma.supplier.create({ data: { tenantId: a.tenantId, type: 'DMC', legalName: `${a.key} LLC`, displayName: 'Hotelco', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const alice = await a.user('alice')
    const agencyId = (await prisma.agency.create({ data: { tenant: { connect: { id: a.tenantId } }, createdBy: { connect: { id: alice } }, name: `${a.key} agency`, code: `${suffix}-AG` } as never })).id
    A = { tenantId: a.tenantId, supplierId, agencyId, alice, bob: await a.user('bob') }
    B = { tenantId: b.tenantId, alice: await b.user('alice') }
    const settle = (reference: string, amountMinor: bigint, over: Record<string, unknown> = {}) => prisma.supplierSettlement.create({ data: {
      tenantId: A.tenantId, supplierId, currency: 'AED', amountMinor, paidOn: new Date('2026-10-02T00:00:00Z'), paymentReference: reference, status: 'APPROVED', requestId: `${reference}-REQ-01`,
      proposedById: A.alice, decidedById: A.bob, decidedAt: new Date(), ...over,
    } })
    await settle(sref('PAY-OK'), 25050n)
    await settle(sref('PAY-SHORT'), 40000n)
    await settle(sref('PAY-GONE'), 9900n)
    await prisma.fundingReceipt.create({ data: {
      tenantId: A.tenantId, agencyId, currency: 'AED', amountMinor: 120000n, method: 'BANK_TRANSFER', bankReference: sref('FUND-1'), valueDate: new Date('2026-10-03T00:00:00Z'), payerName: 'Payer', payerType: 'AGENCY',
      complianceReviewRequired: false, secondApprovalRequired: false, status: 'DECLARED', channel: 'ADMIN', requestId: `${suffix}-fund-req-1`, declaredById: A.alice,
    } as never })
  })

  afterAll(async () => {
    for (const tenantId of tenants) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        for (const table of ['BankMatchFinding', 'BankStatementEntry', 'BankStatement', 'FundingReceipt', 'SupplierSettlement', 'AuditEvent', 'Agency', 'Supplier']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', tenantId)
      })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix.toLowerCase() } } })
    await prisma.$disconnect()
  })

  const body = (over: Record<string, unknown> = {}) => ({
    requestId: rid(), format: 'MT940', content: mt940(sref('S1'), 'AE0700001', [
      { dc: 'D', amount: '250,50', ref: sref('PAY-OK') },       // matches settlement
      { dc: 'D', amount: '350,00', ref: sref('PAY-SHORT') },    // amount mismatch (settlement says 400.00)
      { dc: 'C', amount: '1200,', ref: sref('FUND-1') },        // matches funding receipt
      { dc: 'C', amount: '77,00', ref: sref('NOBODY') },        // suspense
    ]), ...over,
  })

  it('BANK-FLAG: with the flag unset every write answers 503 and nothing is stored', async () => {
    delete process.env.FINANCE_RECONCILIATION_ENABLED
    try {
      await expect(service.importStatement(A.tenantId, A.alice, body())).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(await prisma.bankStatement.count({ where: { tenantId: A.tenantId } })).toBe(0)
    } finally { process.env.FINANCE_RECONCILIATION_ENABLED = 'true' }
  })

  let statementId = ''
  it('BANK-IMPORT: matches settlements out and receipts in by reference, flags the differences, reports a payment missing from the statement, stores no account number', async () => {
    const result = await service.importStatement(A.tenantId, A.alice, body())
    statementId = result.statement.id
    expect(result.replayed).toBe(false)
    expect(result.statement).toMatchObject({ format: 'MT940', currency: 'AED', accountLast4: '0001', entryCount: 4, matched: 2, exceptions: { open: 3, resolved: 0 }, periodStart: '2026-10-02', periodEnd: '2026-10-02' })
    expect(result.summary).toEqual([{ currency: 'AED', matched: 2, exceptions: 3, matchedMinor: '145050', unmatchedCreditMinor: '7700', unmatchedDebitMinor: '0' }])
    const findings = await prisma.bankMatchFinding.findMany({ where: { tenantId: A.tenantId, statementId }, orderBy: { findingKey: 'asc' } })
    const type = (key: string) => findings.find((f) => f.findingKey === key)
    expect(type('entry:1')).toMatchObject({ type: 'MATCHED', expectedKind: 'SUPPLIER_SETTLEMENT', varianceMinor: 0n, isException: false })
    expect(type('entry:2')).toMatchObject({ type: 'AMOUNT_MISMATCH', bankMinor: 35000n, expectedMinor: 40000n, varianceMinor: -5000n, status: 'OPEN' })
    expect(type('entry:3')).toMatchObject({ type: 'MATCHED', expectedKind: 'FUNDING_RECEIPT' })
    expect(type('entry:4')).toMatchObject({ type: 'UNMATCHED_ENTRY', expectedId: null })
    expect(findings.filter((f) => f.type === 'EXPECTED_NOT_ON_STATEMENT')).toHaveLength(1)
    const stored = JSON.stringify(await prisma.bankStatement.findFirst({ where: { id: statementId } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(stored).not.toContain('AE0700001')
    expect(await prisma.auditEvent.count({ where: { tenantId: A.tenantId, action: 'finance.bank_reconciliation.statement_imported', entityId: statementId } })).toBe(1)
  })

  it('BANK-IDEMPOTENT: the same requestId returns the same statement; reuse for other content, the same content under a new requestId, and bad input are refused', async () => {
    const original = body()
    const first = await service.importStatement(A.tenantId, A.alice, { ...original, requestId: `${suffix}-fixed-1`, content: mt940(sref('S2'), 'AE0700002', [{ dc: 'C', amount: '5,00', ref: sref('SOLO') }]) })
    const again = await service.importStatement(A.tenantId, A.alice, { ...original, requestId: `${suffix}-fixed-1`, content: mt940(sref('S2'), 'AE0700002', [{ dc: 'C', amount: '5,00', ref: sref('SOLO') }]) })
    expect(again).toMatchObject({ replayed: true, statement: { id: first.statement.id } })
    await expect(service.importStatement(A.tenantId, A.alice, { ...original, requestId: `${suffix}-fixed-1` })).rejects.toMatchObject({ response: { code: 'BANK_REQUEST_REUSED' } })
    await expect(service.importStatement(A.tenantId, A.alice, { requestId: rid(), format: 'MT940', content: mt940(sref('S2-RENAMED'), 'AE0700002', [{ dc: 'C', amount: '5,00', ref: sref('SOLO') }]) })).rejects.toMatchObject({ response: { code: 'BANK_STATEMENT_DUPLICATE_CONTENT' } })
    await expect(service.importStatement(A.tenantId, A.alice, { requestId: rid(), format: 'MT940', content: 'not a statement' })).rejects.toMatchObject({ response: { code: expect.stringMatching(/^BANK_STATEMENT_/) } })
    await expect(service.importStatement(A.tenantId, A.alice, { requestId: rid(), format: 'MT940', content: mt940(sref('S3'), 'AE0700003', [{ dc: 'C', amount: '5,00', ref: 'X' }]).replace('AED1005,00', 'AED1005,01') })).rejects.toMatchObject({ response: { code: 'BANK_STATEMENT_BALANCE_MISMATCH' } })
  })

  it('BANK-DUPLICATE-PAYMENT: a payment matched by an earlier statement is not matched again and is not reported missing', async () => {
    const second = await service.importStatement(A.tenantId, A.alice, { requestId: rid(), format: 'MT940', content: mt940(sref('S4'), 'AE0700001', [{ dc: 'D', amount: '250,50', ref: sref('PAY-OK') }, { dc: 'C', amount: '1,00', ref: sref('X-4') }]) })
    expect(second.statement.matched).toBe(0)
    const rows = await prisma.bankMatchFinding.findMany({ where: { tenantId: A.tenantId, statementId: second.statement.id, isException: true } })
    const paid = await prisma.supplierSettlement.findFirstOrThrow({ where: { tenantId: A.tenantId, paymentReference: sref('PAY-OK') } })
    expect(rows.filter((r) => r.type === 'DUPLICATE_PAYMENT').map((r) => r.expectedId)).toEqual([paid.id])
    expect(rows.some((r) => r.type === 'UNMATCHED_ENTRY')).toBe(true)
    expect(rows.some((r) => r.type === 'EXPECTED_NOT_ON_STATEMENT' && r.expectedId === paid.id)).toBe(false)
  })

  it('BANK-IMMUTABLE: a statement, its entries and a finding\'s facts cannot be changed, and nothing is ever deleted, even by the owner role', async () => {
    await expect(prisma.bankStatement.update({ where: { id: statementId }, data: { statementRef: 'tampered' } })).rejects.toThrow(/immutable/)
    await expect(prisma.bankStatementEntry.updateMany({ where: { statementId }, data: { amountMinor: 1n } })).rejects.toThrow(/immutable/)
    await expect(prisma.bankStatementEntry.deleteMany({ where: { statementId } })).rejects.toThrow(/immutable/)
    const f = await prisma.bankMatchFinding.findFirstOrThrow({ where: { tenantId: A.tenantId, statementId, type: 'AMOUNT_MISMATCH' } })
    await expect(prisma.bankMatchFinding.update({ where: { id: f.id }, data: { bankMinor: 40000n } })).rejects.toThrow(/immutable|violates check/)
    await expect(prisma.bankMatchFinding.delete({ where: { id: f.id } })).rejects.toThrow(/never deleted/)
  })

  it('BANK-TENANT: another tenant sees none of it', async () => {
    expect((await service.listStatements(B.tenantId, {})).total).toBe(0)
    expect((await service.listExceptions(B.tenantId, B.alice, {})).total).toBe(0)
    await expect(service.getStatement(B.tenantId, statementId)).rejects.toMatchObject({ status: 404 })
  })

  it('BANK-RESOLVE: whoever imported the statement cannot close its exceptions; another person can, once, with a reason; a clean match has nothing to close', async () => {
    const queue = await service.listExceptions(A.tenantId, A.bob, { statementId, status: 'OPEN' })
    expect(queue.total).toBe(3)
    const mismatch = queue.items.find((e) => e.type === 'AMOUNT_MISMATCH')!
    expect(mismatch).toMatchObject({ varianceMinor: '-5000', direction: 'DEBIT', expectedKind: 'SUPPLIER_SETTLEMENT', canResolve: true })
    expect((await service.listExceptions(A.tenantId, A.alice, { statementId })).items.every((e) => !e.canResolve)).toBe(true)
    await expect(service.resolveException(A.tenantId, A.alice, mismatch.id, { resolution: 'EXPLAINED', reason: 'looks fine to me' })).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.resolveException(A.tenantId, A.bob, mismatch.id, { resolution: 'WRITE_OFF' as never, reason: 'nope nope' })).rejects.toMatchObject({ status: 400 })
    await expect(service.resolveException(A.tenantId, A.bob, mismatch.id, { resolution: 'EXPLAINED', reason: 'x' })).rejects.toMatchObject({ status: 400 })
    const done = await service.resolveException(A.tenantId, A.bob, mismatch.id, { resolution: 'BANK_CORRECTION_REQUESTED', reason: 'Bank deducted a transfer fee; asked for a corrected advice' })
    expect(done).toMatchObject({ status: 'RESOLVED', resolution: 'BANK_CORRECTION_REQUESTED', resolvedById: A.bob })
    await expect(service.resolveException(A.tenantId, A.bob, mismatch.id, { resolution: 'EXPLAINED', reason: 'again again' })).rejects.toMatchObject({ response: { code: 'BANK_EXCEPTION_RESOLVED' } })
    const clean = await prisma.bankMatchFinding.findFirstOrThrow({ where: { tenantId: A.tenantId, statementId, type: 'MATCHED' } })
    await expect(service.resolveException(A.tenantId, A.bob, clean.id, { resolution: 'EXPLAINED', reason: 'no need' })).rejects.toMatchObject({ response: { code: 'BANK_NOT_AN_EXCEPTION' } })
    await expect(prisma.bankMatchFinding.update({ where: { id: mismatch.id }, data: { resolutionReason: 'edited later' } })).rejects.toThrow(/immutable/)
    expect(await prisma.auditEvent.count({ where: { tenantId: A.tenantId, action: 'finance.bank_reconciliation.exception_resolved', entityId: mismatch.id } })).toBe(1)
    expect((await service.getStatement(A.tenantId, statementId)).statement.exceptions).toEqual({ open: 2, resolved: 1 })
  })

  it('BANK-LEDGER: nothing here wrote to the ledger or a wallet', async () => {
    expect(await prisma.ledgerEntry.count({ where: { tenantId: A.tenantId } })).toBe(0)
  })
})
