import { randomBytes } from 'crypto'
import { ServiceUnavailableException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { certifyReconRole, deprovisionReconRole, provisionReconRole, reconGrantStatements, RECON_PROBES } from '../src/database/reconciliation-role'
import { ReconciliationDatabase, ReconciliationStore } from '../src/finance-reconciliation/reconciliation-store'
import { ReconciliationService } from '../src/finance-reconciliation/reconciliation.service'
import { ReconciliationRunner } from '../src/finance-reconciliation/reconciliation-runner.service'
import { ReconciliationWorker } from '../src/finance-reconciliation/reconciliation-worker.service'
import { BankReconciliationService } from '../src/finance-reconciliation/bank-reconciliation.service'

/** ADR 0070: the whole workflow under the narrow reconciliation login, with no way to touch the ledger, a wallet or a booking. */
describe('finance reconciliation under its narrow database role (ADR 0070, PostgreSQL)', () => {
  const owner = new PrismaService()
  const suffix = `reconrole-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  // Roles are cluster-global: a unique login per run never disturbs another database or run, and the shared NOLOGIN group is never dropped.
  const loginRole = `fbeds_recon_t${randomBytes(4).toString('hex')}`
  let loginUrl: string
  let tenantId: string
  let supplierId: string
  let users: { a: string; b: string }
  let narrow: PrismaClient

  beforeAll(async () => {
    process.env.FINANCE_RECONCILIATION_ENABLED = 'true'
    const ownerUrl = new URL(process.env.DATABASE_URL as string)
    await provisionReconRole(owner, { loginRole, password })
    const login = new URL(ownerUrl.toString())
    login.username = loginRole; login.password = password
    loginUrl = login.toString()
    narrow = new PrismaClient({ datasourceUrl: loginUrl })
    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    supplierId = (await owner.supplier.create({ data: { tenantId, type: 'DMC', legalName: `${suffix} LLC`, displayName: 'Role Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    users = { a: (await owner.user.create({ data: { email: `${suffix}-a@example.test` } })).id, b: (await owner.user.create({ data: { email: `${suffix}-b@example.test` } })).id }
    await owner.booking.create({ data: { tenantId, supplierId, reference: `${suffix}-BK1`, supplier: 'S', hotelId: 'h1', status: 'CONFIRMED', currency: 'AED', totalMinor: 30000n, idempotencyKey: `${suffix}-1`, searchSnapshot: {}, netMinor: 10000n, checkOut: new Date('2026-10-10T00:00:00Z') } as never })
  })

  afterAll(async () => {
    await narrow.$disconnect()
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const table of ['BankMatchFinding', 'BankStatementEntry', 'BankStatement', 'FundingReceipt', 'SupplierSettlement', 'Agency', 'ReconciliationDecision', 'ReconciliationFinding', 'ReconciliationRun', 'SupplierStatementLine', 'SupplierStatement', 'Booking', 'AuditEvent', 'Supplier']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', tenantId)
    })
    await owner.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await deprovisionReconRole(owner, loginRole)
    await owner.$disconnect()
  })

  it('ROLE-CERTIFY: the login passes the catalogue verifier and every privilege probe', async () => {
    const report = await certifyReconRole(narrow)
    expect(report.role.failures).toEqual([])
    expect(report.probes.filter((p) => !p.ok)).toEqual([])
    expect(report.probes).toHaveLength(RECON_PROBES.length)
    const grants = reconGrantStatements().join('\n')
    expect(grants).not.toMatch(/ON "(LedgerEntry|Wallet|users|sessions|BookingGuest|FundingReceipt)"/)
    expect(grants).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE)[A-Z, ]* ON "(Booking|Supplier|BookingFinanceEvent)"/)
  })

  it('ROLE-WORKFLOW: import, queue, match, decide and approve all work as the narrow login, and the ledger stays untouched', async () => {
    const database = new ReconciliationDatabase({ FINANCE_RECONCILIATION_DATABASE_URL: loginUrl, DATABASE_URL: process.env.DATABASE_URL })
    expect(database.configured()).toBe(true)
    const store = new ReconciliationStore(owner, database)
    const service = new ReconciliationService(store)
    const runner = new ReconciliationRunner(store)
    try {
      const statement = await service.importStatement(tenantId, users.a, { supplierId, statementRef: `S-${suffix}`, periodStart: '2026-10-01', periodEnd: '2026-10-31', requestId: `${suffix}-r1`, lines: [{ reference: `${suffix}-BK1`, kind: 'CHARGE', currency: 'AED', amount: '350.00' }] })
      expect(statement.supplier.displayName).toBe('Role Supplier')
      await service.enqueueRun(tenantId, users.a, statement.id, { requestId: `${suffix}-r2` })
      const worker = new ReconciliationWorker(store, runner, { FINANCE_RECONCILIATION_WORKER_ENABLED: 'true', FINANCE_RECONCILIATION_ENABLED: 'true' })
      expect(await worker.runOnce()).toBeGreaterThanOrEqual(1)
      const [exception] = (await service.listExceptions(tenantId, users.a, { statementId: statement.id })).items
      expect(exception).toMatchObject({ type: 'AMOUNT_OVERCHARGE', varianceMinor: '25000', booking: { reference: `${suffix}-BK1` } })
      const pending = await service.proposeDecision(tenantId, users.a, exception.id, { action: 'ACCEPT_STATEMENT', reason: 'Contract amendment attached' })
      expect(pending.exception.status).toBe('PENDING_APPROVAL')
      const done = await service.approveDecision(tenantId, users.b, exception.id, { reason: 'Verified against the amendment' })
      expect(done.exception).toMatchObject({ status: 'RESOLVED', resolvedById: users.b })
      expect((await service.exceptionSummary(tenantId)).byStatus.RESOLVED).toBe(1)
      expect(await owner.ledgerEntry.count({ where: { tenantId } })).toBe(0)
      expect(await owner.auditEvent.count({ where: { tenantId, action: { startsWith: 'finance.reconciliation.' } } })).toBeGreaterThanOrEqual(5)
    } finally { await database.onModuleDestroy() }
  })

  it('ROLE-BANK: a bank statement imports, matches settlements and funding receipts, and closes an exception as the narrow login, and the ledger stays untouched', async () => {
    const database = new ReconciliationDatabase({ FINANCE_RECONCILIATION_DATABASE_URL: loginUrl, DATABASE_URL: process.env.DATABASE_URL })
    const service = new BankReconciliationService(new ReconciliationStore(owner, database))
    const agency = await owner.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: users.a } }, name: `${suffix} agency`, code: `RB${randomBytes(3).toString("hex").toUpperCase()}` } as never })
    await owner.supplierSettlement.create({ data: { tenantId, supplierId, currency: 'AED', amountMinor: 25050n, paidOn: new Date('2026-10-02T00:00:00Z'), paymentReference: `${suffix}-PAY`, status: 'APPROVED', requestId: `${suffix}-settle-1`, proposedById: users.a, decidedById: users.b, decidedAt: new Date() } })
    await owner.fundingReceipt.create({ data: { tenantId, agencyId: agency.id, currency: 'AED', amountMinor: 120000n, method: 'BANK_TRANSFER', bankReference: `${suffix}-FUND`, valueDate: new Date('2026-10-02T00:00:00Z'), payerName: 'Payer', payerType: 'AGENCY', complianceReviewRequired: false, secondApprovalRequired: false, status: 'DECLARED', channel: 'ADMIN', requestId: `${suffix}-fund-1`, declaredById: users.a } as never })
    const mt940 = [':20:ROLE1', ':25:AE99ROLE', ':60F:C261001AED1000,00',
      `:61:2610021002D250,50NTRFNONREF//B1`, `:86:${suffix}-PAY`,
      `:61:2610021002C1200,NTRFNONREF//B2`, `:86:${suffix}-FUND`,
      `:61:2610021002C3,00NTRFNONREF//B3`, ':86:UNKNOWN',
      ':62F:C261003AED1952,50', '-'].join('\n')
    try {
      const result = await service.importStatement(tenantId, users.a, { requestId: `${suffix}-bank-1`, format: 'MT940', content: mt940 })
      expect(result.statement).toMatchObject({ matched: 2, exceptions: { open: 1, resolved: 0 } })
      const [unmatched] = (await service.listExceptions(tenantId, users.b, { statementId: result.statement.id })).items
      expect(unmatched).toMatchObject({ type: 'UNMATCHED_ENTRY', canResolve: true })
      const done = await service.resolveException(tenantId, users.b, unmatched.id, { resolution: 'EXPLAINED', reason: 'Bank interest, confirmed with treasury' })
      expect(done).toMatchObject({ status: 'RESOLVED', resolvedById: users.b })
      expect(await owner.ledgerEntry.count({ where: { tenantId } })).toBe(0)
      expect(await owner.auditEvent.count({ where: { tenantId, action: { startsWith: 'finance.bank_reconciliation.' } } })).toBe(2)
    } finally { await database.onModuleDestroy() }
  })

  it('ROLE-FAIL-CLOSED: a configured but unusable login is a typed 503, never a fallback to the HTTP client', async () => {
    const bad = new URL(loginUrl); bad.username = 'fbeds_recon_missing'
    const database = new ReconciliationDatabase({ FINANCE_RECONCILIATION_DATABASE_URL: bad.toString(), DATABASE_URL: process.env.DATABASE_URL })
    const service = new ReconciliationService(new ReconciliationStore(owner, database))
    try {
      await expect(service.listStatements(tenantId, {})).rejects.toBeInstanceOf(ServiceUnavailableException)
      await expect(service.listStatements(tenantId, {})).rejects.toMatchObject({ response: { code: 'FINANCE_RECONCILIATION_UNAVAILABLE' } })
    } finally { await database.onModuleDestroy() }
  })
})
