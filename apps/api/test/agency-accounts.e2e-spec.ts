import { randomBytes } from 'crypto'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { AgentFinanceService } from '../src/agent/finance.service'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'

// Launch policy (ADR 0029): only AED is enabled, so a not-opened agency lists exactly one AED position.
process.env.SETTLEMENT_CURRENCIES = 'AED'

/**
 * ADR 0028 slice 1: agency accounts, read-only. No code path posts to an agency account in this slice, so the agency-account rows
 * and ledger entries below are FIXTURES written with the owner connection, standing in for the funding that slice 2 will post.
 */
describe('agency accounts (ADR 0028 slice 1, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const ops = new OperationsTransactionsService(prisma, {} as never)
  const agentFinance = new AgentFinanceService(prisma)
  const suffix = `acct-${Date.now()}-${randomBytes(3).toString('hex')}`
  const created: string[] = []
  let A: { tenantId: string; agencyId: string; otherAgencyId: string; houseId: string }
  let B: { tenantId: string; agencyId: string }

  async function tenant(tag: string) {
    const key = `${suffix}-${tag}`
    const tenantId = (await prisma.tenant.create({ data: { name: key, slug: key } })).id
    const userId = (await prisma.user.create({ data: { email: `${key}@example.test` } })).id
    created.push(tenantId)
    const agency = (code: string) => prisma.agency.create({ data: { tenantId, code: `${code}-${tag}`.toUpperCase(), name: `${code} ${tag}`, createdById: userId } })
    return { tenantId, userId, agency }
  }

  beforeAll(async () => {
    const a = await tenant('a')
    const b = await tenant('b')
    const houseId = (await prisma.wallet.create({ data: { tenantId: a.tenantId, currency: 'AED', creditLimit: 0n } })).id
    A = { tenantId: a.tenantId, agencyId: (await a.agency('gulf')).id, otherAgencyId: (await a.agency('nile')).id, houseId }
    B = { tenantId: b.tenantId, agencyId: (await b.agency('desert')).id }
  })

  afterAll(async () => {
    for (const tenantId of created) {
      await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
      await prisma.wallet.deleteMany({ where: { tenantId } })
      await prisma.agency.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('ACCT-DB: one house account and one account per agency per currency; agencies of another tenant are refused', async () => {
    await expect(prisma.wallet.create({ data: { tenantId: A.tenantId, currency: 'AED' } })).rejects.toThrow()
    const acct = await prisma.wallet.create({ data: { tenantId: A.tenantId, agencyId: A.agencyId, currency: 'AED' } })
    await expect(prisma.wallet.create({ data: { tenantId: A.tenantId, agencyId: A.agencyId, currency: 'AED' } })).rejects.toThrow()
    await expect(prisma.wallet.create({ data: { tenantId: A.tenantId, agencyId: B.agencyId, currency: 'AED' } })).rejects.toThrow()
    await expect(prisma.wallet.update({ where: { id: acct.id }, data: { agencyId: B.agencyId } })).rejects.toThrow()
    await expect(prisma.agency.delete({ where: { id: A.agencyId } })).rejects.toThrow()
    await prisma.ledgerEntry.createMany({ data: [
      { tenantId: A.tenantId, walletId: acct.id, type: 'CREDIT', amountMinor: 500_000n, currency: 'AED', idempotencyKey: `${suffix}-fund-1` },
      { tenantId: A.tenantId, walletId: acct.id, type: 'CREDIT', amountMinor: 250_000n, currency: 'AED', idempotencyKey: `${suffix}-fund-2` },
    ] })
  })

  it('ACCT-POSITION: an open account sums the whole ledger; an agency without one is NOT_OPENED with zero; other tenants are 404', async () => {
    const open = await ops.agencyAccount(A.tenantId, A.agencyId)
    expect(open.bookingsPostTo).toBe('HOUSE')
    expect(open.fundingEnabled).toBe(false)
    expect(open.accounts).toEqual([expect.objectContaining({ currency: 'AED', status: 'OPEN', balanceMinor: '750000', entryCount: 2 })])
    expect(open.accounts[0].recent).toHaveLength(2)

    const none = await ops.agencyAccount(A.tenantId, A.otherAgencyId)
    expect(none.accounts).toEqual([{ currency: 'AED', status: 'NOT_OPENED', accountId: null, balanceMinor: '0', entryCount: 0, lastEntryAt: null, recent: [] }])

    await expect(ops.agencyAccount(A.tenantId, B.agencyId)).rejects.toBeInstanceOf(NotFoundException)
    await expect(ops.agencyAccount(B.tenantId, A.agencyId)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('ACCT-LIST: wallets are labelled HOUSE or AGENCY and filter by owner and agency', async () => {
    const all = (await ops.wallets(A.tenantId, {})).items
    expect(all.map(w => [w.owner, w.agency?.id ?? null])).toEqual([['HOUSE', null], ['AGENCY', A.agencyId]])
    expect((await ops.wallets(A.tenantId, { owner: 'HOUSE' })).items.map(w => w.id)).toEqual([A.houseId])
    expect((await ops.wallets(A.tenantId, { owner: 'AGENCY' })).items).toHaveLength(1)
    expect((await ops.wallets(A.tenantId, { agencyId: A.otherAgencyId })).items).toHaveLength(0)
    expect((await ops.wallets(B.tenantId, {})).items).toHaveLength(0)
  })

  it('ACCT-ISOLATION: money in an agency account is never spendable through the house account the booking path uses', async () => {
    // House: limit 0, no entries. Agency account: 7,500.00 AED. Before this slice a tenant-wide lookup could have picked either row.
    await expect(agentFinance.assertFunds(A.tenantId, 1n, 'AED')).rejects.toBeInstanceOf(ForbiddenException)
    const summary = await agentFinance.summary(A.tenantId)
    expect(summary).toMatchObject({ status: 'active', currency: 'AED', balance: '0', availableCredit: '0' })
  })
})
