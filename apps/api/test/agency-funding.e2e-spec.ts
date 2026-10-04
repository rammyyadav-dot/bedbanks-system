import { randomBytes } from 'crypto'
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { FundingService } from '../src/funding/funding.service'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'
import { AgentFinanceService } from '../src/agent/finance.service'

// Launch policy (ADR 0029): AED only.
process.env.SETTLEMENT_CURRENCIES = 'AED'

/** ADR 0028 slice 2 on PostgreSQL: the funding workflow, its separation of duties, and the one CREDIT that posting appends. */
describe('agency funding receipts (ADR 0028 slice 2, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const funding = new FundingService(prisma, new AgentAuditService(prisma))
  const ops = new OperationsTransactionsService(prisma, {} as never)
  const agentFinance = new AgentFinanceService(prisma)
  const suffix = `fund-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tenants: string[] = []
  let A: { tenantId: string; agencyId: string; alice: string; bob: string; carol: string; agent: string; outsider: string }
  let B: { tenantId: string; bob: string }
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  let n = 0
  const declaration = (over: Record<string, unknown> = {}) => ({
    currency: 'AED', amountMinor: '500000', method: 'BANK_TRANSFER', bankReference: `${suffix}-ref-${++n}`, valueDate: yesterday,
    payerName: 'Gulf Travel LLC', payerType: 'AGENCY', requestId: `${suffix}-req-${n}`, ...over,
  })

  async function tenant(tag: string) {
    const key = `${suffix}-${tag}`
    const tenantId = (await prisma.tenant.create({ data: { name: key, slug: key } })).id
    tenants.push(tenantId)
    const user = async (name: string) => (await prisma.user.create({ data: { email: `${key}-${name}@example.test` } })).id
    return { tenantId, user }
  }

  beforeAll(async () => {
    process.env.FUNDING_ENABLED = 'true'
    const a = await tenant('a'); const b = await tenant('b')
    const alice = await a.user('alice')
    const agencyId = (await prisma.agency.create({ data: { tenantId: a.tenantId, code: `${suffix}-GULF`.toUpperCase(), name: 'Gulf Travel', createdById: alice } })).id
    const agent = await a.user('agent')
    await prisma.agencyMember.create({ data: { tenantId: a.tenantId, agencyId, userId: agent } })
    A = { tenantId: a.tenantId, agencyId, alice, bob: await a.user('bob'), carol: await a.user('carol'), agent, outsider: await a.user('outsider') }
    B = { tenantId: b.tenantId, bob: await b.user('bob') }
    // House account with no money: proves funding never reaches the booking path in this slice.
    await prisma.wallet.create({ data: { tenantId: A.tenantId, currency: 'AED', creditLimit: 0n } })
  })

  afterAll(async () => {
    for (const tenantId of tenants) {
      await prisma.fundingReceipt.deleteMany({ where: { tenantId } })
      await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
      await prisma.wallet.deleteMany({ where: { tenantId } })
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.agencyMember.deleteMany({ where: { tenantId } })
      await prisma.agency.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  const ledgerFor = (receiptId: string) => prisma.ledgerEntry.findMany({ where: { tenantId: A.tenantId, idempotencyKey: `funding:${receiptId}` } })

  it('FUND-FLAG: with FUNDING_ENABLED unset every write answers 503 and nothing is stored', async () => {
    delete process.env.FUNDING_ENABLED
    try {
      await expect(funding.adminDeclare(A.tenantId, A.alice, { ...declaration(), agencyId: A.agencyId })).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(await prisma.fundingReceipt.count({ where: { tenantId: A.tenantId } })).toBe(0)
    } finally { process.env.FUNDING_ENABLED = 'true' }
  })

  it('FUND-SMALL: declare, verify by another person, post by the verifier; one CREDIT opens the agency account', async () => {
    const r = await funding.adminDeclare(A.tenantId, A.alice, { ...declaration(), agencyId: A.agencyId })
    expect(r).toMatchObject({ status: 'DECLARED', secondApprovalRequired: false, complianceReviewRequired: false, canVerify: false })
    await expect(funding.verify(A.tenantId, A.alice, r.id, {})).rejects.toBeInstanceOf(ForbiddenException)
    await expect(funding.post(A.tenantId, A.bob, r.id)).rejects.toBeInstanceOf(ConflictException)
    expect((await funding.verify(A.tenantId, A.bob, r.id, { note: 'matched statement line' })).status).toBe('VERIFIED')
    await expect(funding.post(A.tenantId, A.alice, r.id)).rejects.toBeInstanceOf(ForbiddenException)
    const posted = await funding.post(A.tenantId, A.bob, r.id)
    expect(posted).toMatchObject({ status: 'POSTED', postedById: A.bob })
    expect(await funding.post(A.tenantId, A.bob, r.id)).toMatchObject({ status: 'POSTED' })
    const entries = await ledgerFor(r.id)
    expect(entries).toEqual([expect.objectContaining({ type: 'CREDIT', amountMinor: 500_000n, walletId: posted.accountId })])
    const account = await ops.agencyAccount(A.tenantId, A.agencyId)
    expect(account.accounts).toEqual([expect.objectContaining({ currency: 'AED', status: 'OPEN', balanceMinor: '500000', entryCount: 1 })])
    // The booking path still reads the empty house account.
    await expect(agentFinance.assertFunds(A.tenantId, 1n, 'AED')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('FUND-LARGE: above AED 10,000 the verifier cannot post; a third person can', async () => {
    const r = await funding.adminDeclare(A.tenantId, A.alice, { ...declaration({ amountMinor: '1000001' }), agencyId: A.agencyId })
    expect(r.secondApprovalRequired).toBe(true)
    await funding.verify(A.tenantId, A.bob, r.id, {})
    await expect(funding.post(A.tenantId, A.bob, r.id)).rejects.toBeInstanceOf(ForbiddenException)
    expect((await funding.get(A.tenantId, A.bob, r.id)).postBlockedReason).toMatch(/second person/)
    expect((await funding.post(A.tenantId, A.carol, r.id)).status).toBe('POSTED')
    expect(await ledgerFor(r.id)).toHaveLength(1)
  })

  it('FUND-COMPLIANCE: cash from a third party cannot post until someone other than the declarer clears it', async () => {
    const r = await funding.adminDeclare(A.tenantId, A.alice, { ...declaration({ method: 'CASH_DEPOSIT', payerType: 'THIRD_PARTY', payerName: 'Someone Else' }), agencyId: A.agencyId })
    expect(r.complianceReviewRequired).toBe(true)
    await funding.verify(A.tenantId, A.bob, r.id, {})
    await expect(funding.post(A.tenantId, A.bob, r.id)).rejects.toBeInstanceOf(ConflictException)
    await expect(funding.clearCompliance(A.tenantId, A.alice, r.id, { note: 'checked id' })).rejects.toBeInstanceOf(ForbiddenException)
    await funding.clearCompliance(A.tenantId, A.carol, r.id, { note: 'payer is the agency owner, documents on file' })
    expect((await funding.post(A.tenantId, A.bob, r.id)).status).toBe('POSTED')
  })

  it('FUND-DUP: one live receipt per bank reference, amount and currency; a rejected one frees the reference; requestId replays', async () => {
    const d = declaration()
    const first = await funding.adminDeclare(A.tenantId, A.alice, { ...d, agencyId: A.agencyId })
    expect((await funding.adminDeclare(A.tenantId, A.alice, { ...d, agencyId: A.agencyId })).id).toBe(first.id)
    await expect(funding.adminDeclare(A.tenantId, A.alice, { ...d, amountMinor: '1', agencyId: A.agencyId })).rejects.toBeInstanceOf(ConflictException)
    await expect(funding.adminDeclare(A.tenantId, A.alice, { ...d, bankReference: d.bankReference.toLowerCase(), requestId: `${suffix}-other`, agencyId: A.agencyId })).rejects.toBeInstanceOf(ConflictException)
    await funding.reject(A.tenantId, A.bob, first.id, { reason: 'wrong agency' })
    await expect(funding.post(A.tenantId, A.carol, first.id)).rejects.toBeInstanceOf(ConflictException)
    const again = await funding.adminDeclare(A.tenantId, A.alice, { ...d, requestId: `${suffix}-redeclare`, agencyId: A.agencyId })
    expect(again.status).toBe('DECLARED')
  })

  it('FUND-AGENT: an agency user declares only for its own agency; a non-member cannot declare', async () => {
    const mine = await funding.agentDeclare(A.tenantId, A.agent, declaration())
    expect(mine.status).toBe('DECLARED')
    expect((await prisma.fundingReceipt.findUniqueOrThrow({ where: { id: mine.id } })).channel).toBe('AGENT')
    await expect(funding.agentDeclare(A.tenantId, A.agent, { ...declaration(), agencyId: 'someone-else-agency' })).rejects.toBeInstanceOf(ForbiddenException)
    await expect(funding.agentDeclare(A.tenantId, A.outsider, declaration())).rejects.toBeInstanceOf(ForbiddenException)
    const view = await funding.agentReceipts(A.tenantId, A.agent)
    expect(view.agency?.id).toBe(A.agencyId)
    expect(view.receipts.map(x => x.id)).toContain(mine.id)
    expect((await funding.agentReceipts(A.tenantId, A.outsider)).receipts).toEqual([])
  })

  it('FUND-RACE: two people posting the same receipt at once append exactly one CREDIT', async () => {
    const r = await funding.adminDeclare(A.tenantId, A.alice, { ...declaration(), agencyId: A.agencyId })
    await funding.verify(A.tenantId, A.bob, r.id, {})
    const results = await Promise.allSettled([funding.post(A.tenantId, A.bob, r.id), funding.post(A.tenantId, A.carol, r.id)])
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect(await ledgerFor(r.id)).toHaveLength(1)
  })

  it('FUND-ISOLATION: another tenant cannot read or act on a receipt', async () => {
    const r = await funding.adminDeclare(A.tenantId, A.alice, { ...declaration(), agencyId: A.agencyId })
    await expect(funding.get(B.tenantId, B.bob, r.id)).rejects.toBeInstanceOf(NotFoundException)
    await expect(funding.verify(B.tenantId, B.bob, r.id, {})).rejects.toBeInstanceOf(NotFoundException)
    expect((await funding.list(B.tenantId, B.bob, {})).items).toEqual([])
  })

  it('FUND-DB: the database itself refuses a declarer posting, a POSTED row without its ledger facts, and uncleared compliance', async () => {
    const r = await funding.adminDeclare(A.tenantId, A.alice, { ...declaration({ method: 'CASH_DEPOSIT' }), agencyId: A.agencyId })
    await funding.verify(A.tenantId, A.bob, r.id, {})
    await expect(prisma.fundingReceipt.update({ where: { id: r.id }, data: { verifiedById: A.alice } })).rejects.toThrow()
    await expect(prisma.fundingReceipt.update({ where: { id: r.id }, data: { status: 'POSTED', postedById: A.carol, postedAt: new Date() } })).rejects.toThrow()
    await expect(prisma.fundingReceipt.update({ where: { id: r.id }, data: { complianceReviewRequired: false } })).rejects.toThrow()
    expect((await prisma.fundingReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('VERIFIED')
  })
})
