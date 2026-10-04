import { randomBytes } from 'crypto'
import { ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'
import { AgentFinanceService } from '../src/agent/finance.service'
import { assertAgencyCredit } from '../src/agent/agency-credit'
import { bookingAccountFor } from '../src/agent/agency-account'

process.env.SETTLEMENT_CURRENCIES = 'AED'

/** ADR 0028 slice 4 on PostgreSQL: FIFO aging of settled charges, the 7-day notice and the 30-day refusal of new holds and bookings. */
describe('agency overdue controls (ADR 0028 slice 4, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const ops = new OperationsTransactionsService(prisma, {} as never)
  const finance = new AgentFinanceService(prisma)
  const suffix = `due-${Date.now()}-${randomBytes(3).toString('hex')}`
  const DAY = 86_400_000
  let tenantId: string, userId: string, agencyId: string, accountId: string
  let seq = 0
  const entry = (type: 'DEBIT' | 'CREDIT', amountMinor: bigint, daysAgo: number) => prisma.ledgerEntry.create({ data: {
    tenantId, walletId: accountId, type, amountMinor, currency: 'AED', reference: type === 'DEBIT' ? `booking:${suffix}-${++seq}` : `funding:${suffix}-${++seq}`,
    idempotencyKey: `${suffix}-${seq}`, immutableAt: new Date(Date.now() - daysAgo * DAY),
  } })
  const holdCheck = () => prisma.withTenant(tenantId, tx => assertAgencyCredit(tx, tenantId, userId, 'AED', 1n))
  const bookCheck = () => prisma.withTenant(tenantId, tx => bookingAccountFor(tx, tenantId, userId, 'AED'))
  const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e instanceof ForbiddenException ? (e.getResponse() as { code: string }).code : 'OTHER' } }

  beforeAll(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    agencyId = (await prisma.agency.create({ data: { tenantId, code: `${suffix}`.toUpperCase(), name: 'Overdue Travel', createdById: userId } })).id
    await prisma.agencyMember.create({ data: { tenantId, agencyId, userId } })
    await prisma.agencyCreditLimit.create({ data: { tenantId, agencyId, currency: 'AED', limitMinor: 1_000_000n, updatedById: userId } })
    accountId = (await prisma.wallet.create({ data: { tenantId, agencyId, currency: 'AED' } })).id
  })

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await prisma.agencyCreditLimit.deleteMany({ where: { tenantId } })
    await prisma.agencyMember.deleteMany({ where: { tenantId } })
    await prisma.agency.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it('DUE-01 a charge 10 days old is a NOTICE: listed in receivables, shown to the agent, and holds still allowed', async () => {
    await entry('DEBIT', -200_000n, 10)
    await expect(holdCheck()).resolves.toBeUndefined()
    await expect(bookCheck()).resolves.toMatchObject({ id: accountId })
    const r = await ops.receivables(tenantId)
    expect(r.items).toEqual([expect.objectContaining({ accountId, overdue: expect.objectContaining({ state: 'NOTICE', unpaidMinor: '200000', daysOverdue: 10 }) })])
    expect(r.counts).toEqual({ notice: 1, holdsRefused: 0 })
    expect(await finance.summary(tenantId, userId)).toMatchObject({ scope: 'agency', overdue: { state: 'NOTICE', daysOverdue: 10 } })
  })

  it('DUE-02 an older charge 31 days old refuses new holds and bookings despite available credit', async () => {
    await entry('DEBIT', -100_000n, 31)
    expect(await code(holdCheck())).toBe('AGENCY_CREDIT_OVERDUE')
    expect(await code(bookCheck())).toBe('AGENCY_CREDIT_OVERDUE')
    expect((await ops.receivables(tenantId)).items[0].overdue).toMatchObject({ state: 'HOLDS_REFUSED', unpaidMinor: '300000', daysOverdue: 31 })
  })

  it('DUE-03 a payment settles the oldest charge first: paying the 31-day charge lifts the refusal, the 10-day one stays a notice', async () => {
    await entry('CREDIT', 100_000n, 0)
    await expect(holdCheck()).resolves.toBeUndefined()
    expect((await ops.receivables(tenantId)).items[0].overdue).toMatchObject({ state: 'NOTICE', unpaidMinor: '200000', daysOverdue: 10 })
    await entry('CREDIT', 200_000n, 0)
    expect((await ops.receivables(tenantId)).items).toEqual([])
  })
})
