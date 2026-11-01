import { randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { FinancePeriodService } from '../src/finance-periods/finance-period.service'

jest.setTimeout(120_000)

/** ADR 0101 on PostgreSQL: month close with control totals, ordering, the integrity gate, the database lock on closed periods, and immutability. */
describe('finance period close (ADR 0101, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const service = new FinancePeriodService(prisma)
  const suffix = `fp-${Date.now()}-${randomBytes(3).toString('hex')}`
  let tenantId = '', aedWallet = '', usdWallet = '', alice = ''
  let n = 0
  const at = (iso: string) => new Date(iso)
  const entry = (wallet: string, currency: string, amountMinor: bigint, iso: string) =>
    prisma.ledgerEntry.create({ data: { tenantId, walletId: wallet, type: 'CREDIT', amountMinor, currency, reference: `manual:${suffix}-${++n}`, idempotencyKey: `${suffix}-e${n}`, immutableAt: at(iso) } })
  const clockAt = (iso: string) => { service.clock = () => at(iso) }
  const withFlag = async (value: string | undefined, work: () => Promise<void>) => {
    const before = process.env.FINANCE_PERIOD_CLOSE_ENABLED
    if (value === undefined) delete process.env.FINANCE_PERIOD_CLOSE_ENABLED; else process.env.FINANCE_PERIOD_CLOSE_ENABLED = value
    try { await work() } finally { if (before === undefined) delete process.env.FINANCE_PERIOD_CLOSE_ENABLED; else process.env.FINANCE_PERIOD_CLOSE_ENABLED = before }
  }

  beforeAll(async () => {
    process.env.FINANCE_PERIOD_CLOSE_ENABLED = 'true'
    const slug = `${suffix}-t`
    tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    alice = (await prisma.user.create({ data: { email: `${suffix}-alice@example.test` } })).id
    const agency = async (tag: string) => (await prisma.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: alice } }, name: `${slug} ${tag}`, code: `FP${randomBytes(3).toString('hex').toUpperCase()}` } as never })).id
    aedWallet = (await prisma.wallet.create({ data: { tenantId, agencyId: await agency('a'), currency: 'AED' } })).id
    usdWallet = (await prisma.wallet.create({ data: { tenantId, agencyId: await agency('b'), currency: 'USD' } })).id
    await entry(aedWallet, 'AED', 1000n, '2026-08-10T09:00:00Z'); await entry(aedWallet, 'AED', 500n, '2026-08-31T23:59:59Z'); await entry(usdWallet, 'USD', 70n, '2026-08-15T12:00:00Z')
    await entry(aedWallet, 'AED', 200n, '2026-09-01T00:00:00Z')
  })

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const table of ['FinancePeriodClose', 'LedgerChainLink', 'LedgerEntry', 'Wallet', 'AuditEvent', 'Agency']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, tenantId)
      await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', tenantId)
    })
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('PERIOD-FLAG: with the flag unset closing answers 503 and stores nothing; preview still works', async () => {
    clockAt('2026-10-02T00:00:00Z')
    await withFlag(undefined, async () => {
      await expect(service.close(tenantId, alice, { month: '2026-08' })).rejects.toMatchObject({ response: { code: 'FINANCE_PERIOD_CLOSE_DISABLED' } })
      expect((await service.preview(tenantId, { month: '2026-08' })).closable).toBe(true)
    })
    expect(await prisma.financePeriodClose.count({ where: { tenantId } })).toBe(0)
  })

  it('PERIOD-PREVIEW: totals tie per currency and writes nothing; the first period must be the month of the earliest entry', async () => {
    const aug = await service.preview(tenantId, { month: '2026-08' })
    expect(aug).toMatchObject({ closable: true, blockers: [], integrityVerdict: expect.stringMatching(/CLEAN|WARNINGS/), periodStart: '2026-08-01', periodEnd: '2026-09-01' })
    expect(aug.totals.map(t => [t.currency, t.entries, t.openingMinor, t.movementMinor, t.closingMinor])).toEqual([['AED', 2, '0', '1500', '1500'], ['USD', 1, '0', '70', '70']])
    const sep = await service.preview(tenantId, { month: '2026-09' })
    expect(sep).toMatchObject({ closable: false, blockers: ['PERIOD_NOT_NEXT'] })
    expect(sep.totals.find(t => t.currency === 'AED')).toMatchObject({ openingMinor: '1500', movementMinor: '200', closingMinor: '1700' })
    expect(await prisma.financePeriodClose.count({ where: { tenantId } })).toBe(0)
  })

  it('PERIOD-VALIDATION: a bad month or note is a 400', async () => {
    for (const month of ['2026-13', '2026-8', undefined, 7]) await expect(service.close(tenantId, alice, { month })).rejects.toMatchObject({ status: 400, response: { code: 'FINANCE_PERIOD_INVALID' } })
    await expect(service.close(tenantId, alice, { month: '2026-08', note: 'no' })).rejects.toMatchObject({ status: 400 })
    await expect(service.close(tenantId, alice, null)).rejects.toMatchObject({ status: 400 })
    await expect(service.preview(tenantId, {})).rejects.toMatchObject({ status: 400 })
  })

  it('PERIOD-CLOSE: closing stores the totals and chain heads, audits, and cannot be repeated', async () => {
    const closed = await service.close(tenantId, alice, { month: '2026-08', note: 'August reviewed, no exceptions' })
    expect(closed).toMatchObject({ month: '2026-08', periodStart: '2026-08-01', periodEnd: '2026-09-01', warningCount: expect.any(Number), note: 'August reviewed, no exceptions', closedById: alice })
    expect(closed.totals.find(t => t.currency === 'AED')).toMatchObject({ openingMinor: '0', movementMinor: '1500', closingMinor: '1500', byType: [{ type: 'CREDIT', entries: 2, sumMinor: '1500' }] })
    expect(closed.chainHeads.length).toBe(2)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'finance.period.closed', entityId: closed.id } })
    expect(audit.payload).toMatchObject({ month: '2026-08' })
    await expect(service.close(tenantId, alice, { month: '2026-08' })).rejects.toMatchObject({ response: { code: 'FINANCE_PERIOD_BLOCKED', details: { blockers: ['PERIOD_ALREADY_CLOSED'] } } })
    const listed = await service.list(tenantId, {})
    expect(listed.items.map(p => p.month)).toEqual(['2026-08'])
  })

  it('PERIOD-LOCK: the database refuses a ledger entry dated inside a closed period, for any role; the open period still accepts entries', async () => {
    await expect(entry(aedWallet, 'AED', 1n, '2026-08-20T00:00:00Z')).rejects.toThrow(/closed finance period/)
    await expect(entry(aedWallet, 'AED', 1n, '2026-08-31T23:59:59.999Z')).rejects.toThrow(/closed finance period/)
    await entry(aedWallet, 'AED', 5n, '2026-09-02T00:00:00Z')
    await entry(aedWallet, 'AED', 6n, new Date().toISOString())
  })

  it('PERIOD-IMMUTABLE: a close record cannot be changed, reopened or deleted', async () => {
    const row = await prisma.financePeriodClose.findFirstOrThrow({ where: { tenantId } })
    await expect(prisma.financePeriodClose.update({ where: { id: row.id }, data: { note: 'edited' } })).rejects.toThrow(/append-only/)
    await expect(prisma.financePeriodClose.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/)
  })

  it('PERIOD-ORDER: the next month closes in sequence, with its opening equal to the last closing, and an unfinished month is refused', async () => {
    await expect(service.close(tenantId, alice, { month: '2026-10' })).rejects.toMatchObject({ response: { details: { blockers: expect.arrayContaining(['PERIOD_NOT_NEXT']) } } })
    const sep = await service.close(tenantId, alice, { month: '2026-09' })
    const aed = sep.totals.find(t => t.currency === 'AED')!
    expect(aed.openingMinor).toBe('1500')
    expect(BigInt(aed.openingMinor) + BigInt(aed.movementMinor)).toBe(BigInt(aed.closingMinor))
    expect(aed.movementMinor).toBe('205')
    expect(sep.totals.find(t => t.currency === 'USD')).toMatchObject({ entries: 0, openingMinor: '70', closingMinor: '70' })
    await expect(service.close(tenantId, alice, { month: '2026-10' })).rejects.toMatchObject({ response: { details: { blockers: ['PERIOD_NOT_ENDED'] } } })
    expect((await service.list(tenantId, {})).items.map(p => p.month)).toEqual(['2026-09', '2026-08'])
  })

  it('PERIOD-INTEGRITY: a critical integrity finding blocks both the preview verdict and the close', async () => {
    await prisma.ledgerEntry.create({ data: { tenantId, walletId: aedWallet, type: 'ADJUSTMENT', amountMinor: 9n, currency: 'AED', reference: 'adjustment:rogue', idempotencyKey: `${suffix}-rogue` } })
    clockAt('2026-11-10T00:00:00Z')
    const preview = await service.preview(tenantId, { month: '2026-10' })
    expect(preview).toMatchObject({ closable: false, integrityVerdict: 'ISSUES', blockers: ['INTEGRITY_ISSUES'] })
    expect(preview.integrityCriticalCount).toBeGreaterThan(0)
    await expect(service.close(tenantId, alice, { month: '2026-10' })).rejects.toMatchObject({ response: { code: 'FINANCE_PERIOD_BLOCKED', details: { blockers: ['INTEGRITY_ISSUES'] } } })
    expect(await prisma.financePeriodClose.count({ where: { tenantId } })).toBe(2)
  })
})
