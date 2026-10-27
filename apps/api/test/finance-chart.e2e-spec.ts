import { createHash, randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { ChartService } from '../src/finance-chart/chart.service'
import { FinancePeriodService } from '../src/finance-periods/finance-period.service'

jest.setTimeout(120_000)

/** ADR 0102 on PostgreSQL: chart set-up, versioned mapping, deactivation rules, immutability, and the balanced journal of a closed month tied to the period close record. */
describe('general-ledger chart and journal (ADR 0102, PostgreSQL)', () => {
  const prisma = new PrismaService()
  const chart = new ChartService(prisma)
  const periods = new FinancePeriodService(prisma)
  const suffix = `gl-${Date.now()}-${randomBytes(3).toString('hex')}`
  let tenantId = '', otherTenantId = '', alice = '', bob = '', carol = '', aedWallet = '', usdWallet = ''
  let n = 0
  const accountId = async (code: string) => (await prisma.glAccount.findFirstOrThrow({ where: { tenantId, code } })).id
  const withFlag = async (value: string | undefined, work: () => Promise<void>) => {
    const before = process.env.FINANCE_CHART_ENABLED
    if (value === undefined) delete process.env.FINANCE_CHART_ENABLED; else process.env.FINANCE_CHART_ENABLED = value
    try { await work() } finally { if (before === undefined) delete process.env.FINANCE_CHART_ENABLED; else process.env.FINANCE_CHART_ENABLED = before }
  }

  beforeAll(async () => {
    process.env.FINANCE_CHART_ENABLED = 'true'; process.env.FINANCE_PERIOD_CLOSE_ENABLED = 'true'
    const slug = `${suffix}-t`
    tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: `${slug}-o`, slug: `${slug}-o` } })).id
    alice = (await prisma.user.create({ data: { email: `${suffix}-alice@example.test` } })).id
    bob = (await prisma.user.create({ data: { email: `${suffix}-bob@example.test` } })).id
    carol = (await prisma.user.create({ data: { email: `${suffix}-carol@example.test` } })).id
    const agency = async (tag: string) => (await prisma.agency.create({ data: { tenant: { connect: { id: tenantId } }, createdBy: { connect: { id: alice } }, name: `${slug} ${tag}`, code: `GL${randomBytes(3).toString('hex').toUpperCase()}` } as never })).id
    const agencyA = await agency('a')
    aedWallet = (await prisma.wallet.create({ data: { tenantId, agencyId: agencyA, currency: 'AED' } })).id
    usdWallet = (await prisma.wallet.create({ data: { tenantId, agencyId: await agency('b'), currency: 'USD' } })).id
    // A posted funding receipt and its CREDIT, so the integrity gate is clean; plus credits that are not funding.
    const receiptId = `${suffix}-receipt`
    const credit = await prisma.ledgerEntry.create({ data: { tenantId, walletId: aedWallet, type: 'CREDIT', amountMinor: 10_000n, currency: 'AED', reference: `funding:${receiptId}`, idempotencyKey: `funding:${receiptId}`, immutableAt: new Date('2026-08-10T09:00:00Z') } })
    await prisma.fundingReceipt.create({ data: { id: receiptId, tenantId, agencyId: agencyA, currency: 'AED', amountMinor: 10_000n, method: 'BANK_TRANSFER', bankReference: `${receiptId}-bank`, valueDate: new Date('2026-08-10'), payerName: 'Fixture payer', payerType: 'AGENCY',
      complianceReviewRequired: false, secondApprovalRequired: false, channel: 'ADMIN', requestId: `${receiptId}-req`, declaredById: alice, status: 'POSTED', verifiedById: bob, verifiedAt: new Date(), postedById: carol, postedAt: new Date(), walletId: aedWallet, ledgerEntryId: credit.id } as never })
    const other = (wallet: string, currency: string, amountMinor: bigint, iso: string) => prisma.ledgerEntry.create({ data: { tenantId, walletId: wallet, type: 'CREDIT', amountMinor, currency, reference: `manual:${++n}`, idempotencyKey: `${suffix}-m${n}`, immutableAt: new Date(iso) } })
    await other(aedWallet, 'AED', 300n, '2026-08-20T09:00:00Z'); await other(usdWallet, 'USD', 70n, '2026-08-21T09:00:00Z')
  })

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const id of [tenantId, otherTenantId]) {
        for (const table of ['GlCategoryMapping', 'GlAccount', 'FinancePeriodClose', 'FundingReceipt', 'LedgerChainLink', 'LedgerEntry', 'Wallet', 'AuditEvent', 'Agency']) await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = $1`, id)
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1', id)
      }
    })
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('CHART-FLAG: with the flag unset every write answers 503, reads still work and nothing is stored', async () => {
    await withFlag(undefined, async () => {
      await expect(chart.initialize(tenantId, alice)).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_DISABLED' } })
      await expect(chart.createAccount(tenantId, alice, { code: '9', name: 'xx', type: 'ASSET' })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_DISABLED' } })
      expect(await chart.get(tenantId)).toMatchObject({ initialized: false, accounts: [], unmappedCategories: expect.arrayContaining(['FUNDING_RECEIVED', 'ADJUSTMENT']) })
    })
    expect(await prisma.glAccount.count({ where: { tenantId } })).toBe(0)
  })

  it('CHART-INIT: the default chart and first mapping versions are created once, audited, and a repeat changes nothing', async () => {
    const first = await chart.initialize(tenantId, alice)
    expect(first.initialized).toBe(true)
    expect(first.accounts.map(a => a.code)).toEqual(['1000', '1900', '2100', '2110', '2200', '6100', '6200', '6900'])
    expect(first.mappings).toHaveLength(9)
    expect(first.unmappedCategories).toEqual([])
    expect(first.mappings.find(m => m.category === 'FUNDING_RECEIVED')).toMatchObject({ version: 1, debit: { code: '1000' }, credit: { code: '2100' } })
    await chart.initialize(tenantId, alice)
    expect(await prisma.glAccount.count({ where: { tenantId } })).toBe(8)
    expect(await prisma.glCategoryMapping.count({ where: { tenantId } })).toBe(9)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'finance.chart.initialized' } })).toBe(1)
  })

  it('CHART-ISOLATION: another tenant sees no chart', async () => {
    expect(await chart.get(otherTenantId)).toMatchObject({ initialized: false, accounts: [] })
  })

  it('CHART-JOURNAL-OPEN: a month that is not closed has no journal; a bad month is a 400', async () => {
    await expect(chart.journal(tenantId, { month: '2026-08' })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_PERIOD_NOT_CLOSED' } })
    await expect(chart.journal(tenantId, { month: '2026-13' })).rejects.toMatchObject({ status: 400 })
  })

  it('CHART-JOURNAL: a closed month journals balanced per currency, ties to the close record and shows what needs classifying', async () => {
    periods.clock = () => new Date('2026-10-02T00:00:00Z')
    await periods.close(tenantId, alice, { month: '2026-08' })
    const j = await chart.journal(tenantId, { month: '2026-08' })
    expect(j).toMatchObject({ month: '2026-08', balanced: true, tiesToClose: true, entries: 3, unmappedEntries: 0, otherCreditEntries: 2 })
    expect(j.lines.find(l => l.currency === 'AED' && l.category === 'FUNDING_RECEIVED')).toMatchObject({ direction: 'POSITIVE', amountMinor: '10000', debit: '1000', credit: '2100', entries: 1 })
    expect(j.lines.find(l => l.currency === 'AED' && l.category === 'OTHER_CREDIT')).toMatchObject({ amountMinor: '300', debit: '1900', credit: '2100' })
    const t = (currency: string, code: string) => j.accountTotals.find(x => x.currency === currency && x.accountCode === code)!
    expect([t('AED', '2100').creditMinor, t('AED', '1000').debitMinor, t('AED', '1900').debitMinor]).toEqual(['10300', '10000', '300'])
    expect(t('USD', '2100')).toMatchObject({ debitMinor: '0', creditMinor: '70' })
    expect(j.mappingVersions.FUNDING_RECEIVED).toBe(1)
  })

  it('CHART-MAPPING: a change is a new version, the same pair is not, and the journal follows the current version', async () => {
    const bank2 = await chart.createAccount(tenantId, alice, { code: '1010', name: 'Bank operating account', type: 'ASSET' })
    await expect(chart.createAccount(tenantId, alice, { code: '1010', name: 'Duplicate', type: 'ASSET' })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_DUPLICATE_CODE' } })
    const set = { category: 'FUNDING_RECEIVED', debitAccountId: bank2.id, creditAccountId: await accountId('2100') }
    expect(await chart.setMapping(tenantId, alice, set)).toMatchObject({ version: 2, debit: { code: '1010' } })
    expect(await chart.setMapping(tenantId, alice, set)).toMatchObject({ version: 2 })
    expect(await prisma.glCategoryMapping.count({ where: { tenantId, category: 'FUNDING_RECEIVED' } })).toBe(2)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'finance.chart.mapping_set' } })).toBe(1)
    const j = await chart.journal(tenantId, { month: '2026-08' })
    expect(j.mappingVersions.FUNDING_RECEIVED).toBe(2)
    expect(j.lines.find(l => l.category === 'FUNDING_RECEIVED')).toMatchObject({ debit: '1010' })
    expect(j.balanced).toBe(true)
  })

  it('CHART-RULES: a mapping needs two different active accounts; an account in use cannot be deactivated; an unused one can', async () => {
    const spare = await chart.createAccount(tenantId, alice, { code: '1020', name: 'Spare bank', type: 'ASSET' })
    await chart.deactivate(tenantId, alice, spare.id)
    await expect(chart.setMapping(tenantId, alice, { category: 'ADJUSTMENT', debitAccountId: spare.id, creditAccountId: await accountId('2100') })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_BAD_MAPPING' } })
    await expect(chart.setMapping(tenantId, alice, { category: 'ADJUSTMENT', debitAccountId: await accountId('6900'), creditAccountId: await accountId('6900') })).rejects.toMatchObject({ status: 400 })
    await expect(chart.setMapping(tenantId, alice, { category: 'ADJUSTMENT', debitAccountId: 'nope', creditAccountId: await accountId('2100') })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_BAD_MAPPING' } })
    await expect(chart.deactivate(tenantId, alice, await accountId('2100'))).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_ACCOUNT_IN_USE' } })
    await expect(chart.deactivate(tenantId, alice, 'missing')).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_NOT_FOUND' } })
    expect((await chart.get(tenantId)).accounts.find(a => a.code === '1020')!.active).toBe(false)
  })

  it('CHART-EXPORT: the lines and totals files carry exact amounts, are audited with the hash of the exact file, and each download is recorded', async () => {
    const lines = await chart.exportJournal(tenantId, alice, 'req-1', { month: '2026-08' })
    expect(lines.name).toBe('gl-journal-2026-08-lines.csv')
    const rows = lines.csv.slice(1).split('\r\n')
    expect(rows[0]).toBe('month,currency,line,category,direction,entries,debit_account,debit_account_name,credit_account,credit_account_name,amount,amount_minor,mapping_version')
    expect(rows).toContain('2026-08,AED,1,FUNDING_RECEIVED,POSITIVE,1,1010,Bank operating account,2100,Agency account balances,100.00,10000,2')
    expect(rows).toContain('2026-08,AED,2,OTHER_CREDIT,POSITIVE,1,1900,Unclassified ledger movements (suspense),2100,Agency account balances,3.00,300,1')
    expect(lines.rows).toBe(3)
    expect(lines.suspenseEntries).toBe(2)
    expect(lines.sha256).toBe(createHash('sha256').update(lines.csv).digest('hex'))
    const totals = await chart.exportJournal(tenantId, alice, 'req-2', { month: '2026-08', kind: 'totals' })
    expect(totals.name).toBe('gl-journal-2026-08-totals.csv')
    expect(totals.csv.slice(1).split('\r\n')).toContain('2026-08,AED,2100,Agency account balances,0.00,103.00,0,10300')
    const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'finance.journal.exported' }, orderBy: { createdAt: 'asc' } })
    expect(audit.map(a => (a.payload as Record<string, unknown>).sha256)).toEqual([lines.sha256, totals.sha256])
    expect(audit[0].payload).toMatchObject({ month: '2026-08', kind: 'lines', rows: 3, requestId: 'req-1' })
    await expect(chart.exportJournal(tenantId, alice, 'r', { month: '2026-08', kind: 'xml' })).rejects.toMatchObject({ status: 400 })
    await expect(chart.exportJournal(tenantId, alice, 'r', { month: '2026-07' })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_PERIOD_NOT_CLOSED' } })
  })

  it('CHART-EXPORT-REFUSED: a journal that no longer ties to the period close record is not exported and nothing is audited', async () => {
    const before = await prisma.auditEvent.count({ where: { tenantId, action: 'finance.journal.exported' } })
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(`INSERT INTO "LedgerEntry" ("id","tenant_id","wallet_id","type","amount_minor","currency","reference","idempotency_key","immutable_at") VALUES ('${suffix}-late',$1,$2,'CREDIT',9,'AED','manual:late','${suffix}-late','2026-08-25T00:00:00Z')`, tenantId, aedWallet)
    })
    const j = await chart.journal(tenantId, { month: '2026-08' })
    expect(j.tiesToClose).toBe(false)
    await expect(chart.exportJournal(tenantId, alice, 'r', { month: '2026-08' })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_JOURNAL_NOT_EXPORTABLE', details: { problems: ['DOES_NOT_TIE_TO_CLOSE'] } } })
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'finance.journal.exported' } })).toBe(before)
  })

  it('CHART-INCOMPLETE: a category with no mapping blocks the journal', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(`DELETE FROM "GlCategoryMapping" WHERE tenant_id = $1 AND category = 'CREDIT_NOTE'`, tenantId)
    })
    await expect(chart.journal(tenantId, { month: '2026-08' })).rejects.toMatchObject({ response: { code: 'FINANCE_CHART_INCOMPLETE', details: { categories: ['CREDIT_NOTE'] } } })
  })

  it('CHART-IMMUTABLE: an account keeps its code, name and type, and a mapping version is never changed or deleted, for any role', async () => {
    const id = await accountId('1000')
    await expect(prisma.glAccount.update({ where: { id }, data: { name: 'Renamed' } })).rejects.toThrow(/immutable/)
    await expect(prisma.glAccount.update({ where: { id }, data: { type: 'LIABILITY' } })).rejects.toThrow(/immutable/)
    await expect(prisma.glAccount.delete({ where: { id } })).rejects.toThrow(/never deleted/)
    const m = await prisma.glCategoryMapping.findFirstOrThrow({ where: { tenantId } })
    await expect(prisma.glCategoryMapping.update({ where: { id: m.id }, data: { version: 99 } })).rejects.toThrow(/append-only/)
    await expect(prisma.glCategoryMapping.delete({ where: { id: m.id } })).rejects.toThrow(/append-only/)
  })
})
