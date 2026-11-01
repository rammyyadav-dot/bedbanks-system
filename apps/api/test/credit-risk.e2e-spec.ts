import { randomBytes } from 'crypto'
import { ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { appendLedgerEntry } from '../src/ledger/ledger-core'
import { enforceCreditRisk } from '../src/agent/agency-account'
import { assertAgencyCredit } from '../src/agent/agency-credit'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'

jest.setTimeout(120_000)

/** ADR 0095 on PostgreSQL: the dynamic credit risk policy at hold and prebook, in shadow and enforce modes, and the admin queue. */
describe('dynamic credit risk (ADR 0095, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const suffix = `risk-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tenants: string[] = []
  let tenantId = ''
  let creator = ''
  let n = 0
  const DAY = 86_400_000
  const key = () => `${suffix}-k${++n}`
  const agencies: Array<{ id: string; userId: string; walletId: string | null }> = []

  /** An AED agency account: `line` approved credit, then ledger entries as (type, amount, daysAgo). */
  async function agency(tag: string, line: bigint, entries: Array<['CREDIT' | 'DEBIT', bigint, number]> = []) {
    const userId = (await prisma.user.create({ data: { email: `${suffix}-${tag}@example.test` } })).id
    const a = await prisma.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: creator } }, name: `${suffix} ${tag}`, code: `RK${randomBytes(3).toString('hex').toUpperCase()}` } as never })
    await prisma.agencyMember.create({ data: { agencyId: a.id, tenantId, userId } })
    if (line > 0n) await prisma.agencyCreditLimit.create({ data: { tenantId, agencyId: a.id, currency: 'AED', limitMinor: line, updatedById: creator } })
    let walletId: string | null = null
    if (entries.length) {
      walletId = (await prisma.wallet.create({ data: { tenantId, agencyId: a.id, currency: 'AED' } })).id
      for (const [type, amount, daysAgo] of entries) {
        await prisma.ledgerEntry.create({ data: { tenantId, walletId, type, amountMinor: type === 'DEBIT' ? -amount : amount, currency: 'AED', reference: `booking:${suffix}-${++n}`, idempotencyKey: key(), immutableAt: new Date(Date.now() - daysAgo * DAY) } })
      }
    }
    agencies.push({ id: a.id, userId, walletId })
    return { id: a.id, userId }
  }
  const check = (a: { id: string; userId: string }, amountMinor: bigint, scope: 'HOLD' | 'PREBOOK') => prisma.withTenant(tenantId, (tx) => enforceCreditRisk(tx, { tenantId, userId: a.userId, agencyId: a.id, currency: 'AED', amountMinor, scope }))
  const audits = (a: { id: string }) => prisma.auditEvent.count({ where: { tenantId, action: 'credit.risk.would_pause', entityId: a.id } })
  const withMode = async (mode: string | undefined, work: () => Promise<void>) => {
    const before = process.env.CREDIT_RISK_ENFORCEMENT
    if (mode === undefined) delete process.env.CREDIT_RISK_ENFORCEMENT; else process.env.CREDIT_RISK_ENFORCEMENT = mode
    try { await work() } finally { if (before === undefined) delete process.env.CREDIT_RISK_ENFORCEMENT; else process.env.CREDIT_RISK_ENFORCEMENT = before }
  }

  beforeAll(async () => {
    const slug = `${suffix}-t`
    tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    tenants.push(tenantId)
    creator = (await prisma.user.create({ data: { email: `${suffix}-creator@example.test` } })).id
  })

  afterAll(async () => {
    for (const id of tenants) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        for (const table of ['LedgerChainLink', 'LedgerEntry', 'Wallet', 'AgencyCreditLimit', 'AgencyMember', 'AuditEvent', 'Agency']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      })
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('RISK-SHADOW: by default a hold that would pause the agency is allowed, and the would-be refusal is audited', async () => {
    const a = await agency('shadow', 100000n, [['DEBIT', 90000n, 1]]) // 90% drawn: MARGIN_CALL
    await withMode(undefined, async () => {
      await expect(check(a, 5001n, 'HOLD')).resolves.toBeUndefined() // projected 95.001%: would pause
      expect(await audits(a)).toBe(1)
      await expect(check(a, 1000n, 'HOLD')).resolves.toBeUndefined() // projected 91%: fine, nothing recorded
      expect(await audits(a)).toBe(1)
    })
  })

  it('RISK-ENFORCE: a hold that would take the agency to 95% is refused with AGENCY_CREDIT_PAUSED and what to pay; just below it is allowed', async () => {
    const a = await agency('enforce', 100000n, [['DEBIT', 90000n, 1]])
    await withMode('enforce', async () => {
      await expect(check(a, 5000n, 'HOLD')).rejects.toMatchObject({ response: { code: 'AGENCY_CREDIT_PAUSED', details: { reasons: ['UTILISATION'], paymentToRestoreMinor: '10001' } } })
      await expect(check(a, 4999n, 'HOLD')).resolves.toBeUndefined()
      expect(await audits(a)).toBe(0)
    })
  })

  it('RISK-OVERDUE-AMOUNT: aged unpaid charges worth half the line pause the agency at hold AND prebook, even with room left; fresh charges do not', async () => {
    const aged = await agency('aged', 100000n, [['DEBIT', 50000n, 10]])
    const fresh = await agency('fresh', 100000n, [['DEBIT', 50000n, 3]])
    await withMode('enforce', async () => {
      for (const scope of ['HOLD', 'PREBOOK'] as const) await expect(check(aged, 1000n, scope)).rejects.toMatchObject({ response: { code: 'AGENCY_CREDIT_PAUSED', details: { reasons: ['OVERDUE_AMOUNT'] } } })
      await expect(check(fresh, 1000n, 'HOLD')).resolves.toBeUndefined()
    })
  })

  it('RISK-PREBOOK: prebook ignores the utilisation rule (the hold being booked is already counted) so an accepted hold is not refused a moment later', async () => {
    const a = await agency('prebook', 100000n, [['DEBIT', 94000n, 1]])
    await withMode('enforce', async () => { await expect(check(a, 90000n, 'PREBOOK')).resolves.toBeUndefined() })
  })

  it('RISK-PREPAID: an agency with no credit line and no overdue charges is never paused by utilisation; payments restore a paused one', async () => {
    const prepaid = await agency('prepaid', 0n, [['CREDIT', 500000n, 2]])
    const paying = await agency('paying', 100000n, [['DEBIT', 60000n, 12]])
    await withMode('enforce', async () => {
      await expect(check(prepaid, 400000n, 'HOLD')).resolves.toBeUndefined()
      await expect(check(paying, 1000n, 'HOLD')).rejects.toBeInstanceOf(ForbiddenException)
      // A payment settles the oldest charge (FIFO), so nothing is overdue any more.
      const wallet = agencies.find((x) => x.id === paying.id)!.walletId as string
      await prisma.withTenant(tenantId, (tx) => appendLedgerEntry(tx, { tenantId, walletId: wallet, type: 'CREDIT', amountMinor: 60000n, currency: 'AED', idempotencyKey: key(), reference: `funding:${suffix}` }))
      await expect(check(paying, 1000n, 'HOLD')).resolves.toBeUndefined()
    })
  })

  it('RISK-HOLD-PATH: the real hold entry point (assertAgencyCredit) applies the policy, and a user in no agency is not checked', async () => {
    const a = await agency('holdpath', 100000n, [['DEBIT', 90000n, 1]])
    await withMode('enforce', async () => {
      await expect(prisma.withTenant(tenantId, (tx) => assertAgencyCredit(tx, tenantId, a.userId, 'AED', 5500n))).rejects.toMatchObject({ response: { code: 'AGENCY_CREDIT_PAUSED' } })
      const stranger = (await prisma.user.create({ data: { email: `${suffix}-stranger@example.test` } })).id
      await expect(prisma.withTenant(tenantId, (tx) => assertAgencyCredit(tx, tenantId, stranger, 'AED', 5500n))).resolves.toBeUndefined()
    })
  })

  it('RISK-QUEUE: the admin queue lists agencies that are not OK, worst first, with the payment to restore, and reports the mode', async () => {
    const service = new OperationsTransactionsService(prisma, undefined as never)
    await withMode('enforce', async () => {
      const view = await service.creditRisk(tenantId)
      expect(view.enforcement).toBe('enforce')
      const byName = (tag: string) => view.items.find((r) => r.agency.name === `${suffix} ${tag}`)
      expect(byName('aged')).toMatchObject({ state: 'PAUSED', reasons: ['OVERDUE_AMOUNT'] })
      expect(byName('enforce')).toMatchObject({ state: 'MARGIN_CALL', utilisationBp: 9000, paymentToRestoreMinor: '10001', drawnMinor: '90000', creditLineMinor: '100000' })
      expect(byName('fresh')).toBeUndefined() // 50% drawn, nothing overdue: OK, so not listed
      expect(byName('prepaid')).toBeUndefined()
      const ranks = view.items.map((r) => ({ PAUSED: 0, MARGIN_CALL: 1, WATCH: 2, OK: 3 })[r.state])
      expect([...ranks].sort((x, y) => x - y)).toEqual(ranks)
      expect(view.counts.paused + view.counts.marginCall + view.counts.watch).toBe(view.items.length)
    })
    await withMode(undefined, async () => { expect((await service.creditRisk(tenantId)).enforcement).toBe('shadow') })
  })
})
