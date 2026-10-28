import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  GL_CATEGORY_NAMES, GL_CHART_FAILURE, GL_JOURNAL_EXPORT_KINDS, type GlJournalExportKind, type GlAccountView, type GlCategoryName, type GlChartView, type GlJournalView, type GlMappingView, type GlAccountTypeName,
} from '@bedbanks/contracts'
import { DEFAULT_GL_ACCOUNTS, DEFAULT_GL_MAPPINGS, GL_CATEGORY_DESCRIPTIONS, GlFold, buildJournal, journalLinesCsv, journalTotalsCsv, mappingProblem, monthRange, type GlAccountRef, type GlMapping } from '@bedbanks/money'
import { PrismaService } from '../database/prisma.service'
import { foldLedgerRange } from '../ledger/ledger-core'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enumParam, idParam } from '../admin-operations/query-params'
import { parseAccountCreate, parseMappingSet, parseMonth } from './chart-input'

const refuse = (status: 400 | 404 | 409 | 503, message: string, code: string, details?: Record<string, unknown>) => {
  const body = { message, code, ...(details && { details }) }
  if (status === 404) return new NotFoundException(body)
  if (status === 409) return new ConflictException(body)
  if (status === 503) return new ServiceUnavailableException(body)
  return new BadRequestException(body)
}
const day = (d: Date) => d.toISOString().slice(0, 10)

/**
 * General-ledger chart of accounts and the derived journal (ADR 0102). Reads need finance.read; writes need finance.chart.manage and FINANCE_CHART_ENABLED=true (else 503).
 * Nothing here posts to the agency ledger or changes a balance. Accounts are never edited or deleted (only deactivated, and not while a current mapping uses them); a mapping change is a
 * new version. The journal of a CLOSED month is recomputed on each read from the locked entries, with the current mapping, and says which versions it used.
 */
@Injectable()
export class ChartService {
  constructor(private readonly prisma: PrismaService) {}

  private assertEnabled(env: NodeJS.ProcessEnv = process.env) {
    if (env.FINANCE_CHART_ENABLED !== 'true') throw refuse(503, 'The chart of accounts is not enabled on this deployment.', GL_CHART_FAILURE.disabled)
  }

  private async currentMappings(tx: Prisma.TransactionClient, tenantId: string) {
    return tx.glCategoryMapping.findMany({ where: { tenantId }, orderBy: [{ category: 'asc' }, { version: 'desc' }], distinct: ['category'], include: { debitAccount: true, creditAccount: true } })
  }

  private async chart(tx: Prisma.TransactionClient, tenantId: string): Promise<GlChartView> {
    const [accounts, mappings] = await Promise.all([tx.glAccount.findMany({ where: { tenantId }, orderBy: { code: 'asc' } }), this.currentMappings(tx, tenantId)])
    const have = new Set(mappings.map(m => m.category))
    return {
      initialized: accounts.length > 0,
      accounts: accounts.map((a): GlAccountView => ({ id: a.id, code: a.code, name: a.name, type: a.type as GlAccountTypeName, active: a.active })),
      mappings: mappings.map((m): GlMappingView => ({
        category: m.category as GlCategoryName, description: GL_CATEGORY_DESCRIPTIONS[m.category as GlCategoryName], version: m.version,
        debit: { id: m.debitAccount.id, code: m.debitAccount.code, name: m.debitAccount.name }, credit: { id: m.creditAccount.id, code: m.creditAccount.code, name: m.creditAccount.name },
      })).sort((a, b) => GL_CATEGORY_NAMES.indexOf(a.category) - GL_CATEGORY_NAMES.indexOf(b.category)),
      unmappedCategories: GL_CATEGORY_NAMES.filter(c => !have.has(c)),
    }
  }

  get(tenantId: string): Promise<GlChartView> { return this.prisma.withTenant(tenantId, tx => this.chart(tx, tenantId)) }

  /** Creates the default chart and its first mapping versions. Safe to repeat: a tenant that already has accounts is returned unchanged. */
  async initialize(tenantId: string, userId: string): Promise<GlChartView> {
    this.assertEnabled()
    return this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gl-chart:${tenantId}`}, 0))`)
      if ((await tx.glAccount.count({ where: { tenantId } })) > 0) return this.chart(tx, tenantId)
      const ids = new Map<string, string>()
      for (const a of DEFAULT_GL_ACCOUNTS) ids.set(a.code, (await tx.glAccount.create({ data: { tenantId, code: a.code, name: a.name, type: a.type, createdById: userId } })).id)
      for (const m of DEFAULT_GL_MAPPINGS) await tx.glCategoryMapping.create({ data: { tenantId, category: m.category, version: 1, debitAccountId: ids.get(m.debit) as string, creditAccountId: ids.get(m.credit) as string, createdById: userId } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.chart.initialized', entityType: 'gl_chart', entityId: tenantId, payload: sanitizeAuditPayload({ accounts: DEFAULT_GL_ACCOUNTS.length, mappings: DEFAULT_GL_MAPPINGS.length }) } })
      return this.chart(tx, tenantId)
    })
  }

  async createAccount(tenantId: string, userId: string, body: unknown): Promise<GlAccountView> {
    this.assertEnabled()
    const p = parseAccountCreate(body)
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const a = await tx.glAccount.create({ data: { tenantId, code: p.code, name: p.name, type: p.type, createdById: userId } })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.chart.account_created', entityType: 'gl_account', entityId: a.id, payload: sanitizeAuditPayload({ code: p.code, type: p.type }) } })
        return { id: a.id, code: a.code, name: a.name, type: a.type as GlAccountTypeName, active: a.active }
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw refuse(409, `Account code ${p.code} already exists`, GL_CHART_FAILURE.duplicateCode)
      throw error
    }
  }

  async deactivate(tenantId: string, userId: string, accountId: string): Promise<GlAccountView> {
    this.assertEnabled()
    const id = idParam('accountId', accountId)
    if (!id) throw refuse(400, 'accountId is required', GL_CHART_FAILURE.invalid)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const a = await tx.glAccount.findFirst({ where: { id, tenantId } })
      if (!a) throw refuse(404, 'Account not found', GL_CHART_FAILURE.notFound)
      const using = (await this.currentMappings(tx, tenantId)).filter(m => m.debitAccountId === id || m.creditAccountId === id).map(m => m.category)
      if (using.length > 0) throw refuse(409, `The account is used by the current mapping of ${using.join(', ')}; map those categories elsewhere first.`, GL_CHART_FAILURE.inUse, { categories: using })
      if (a.active) {
        await tx.glAccount.updateMany({ where: { id, tenantId }, data: { active: false } })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.chart.account_deactivated', entityType: 'gl_account', entityId: id, payload: sanitizeAuditPayload({ code: a.code }) } })
      }
      return { id: a.id, code: a.code, name: a.name, type: a.type as GlAccountTypeName, active: false }
    })
  }

  /** Sets the account pair of a category as a new version. Setting the pair it already has changes nothing. */
  async setMapping(tenantId: string, userId: string, body: unknown): Promise<GlMappingView> {
    this.assertEnabled()
    const p = parseMappingSet(body)
    return this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gl-chart:${tenantId}`}, 0))`)
      const [debit, credit] = await Promise.all([tx.glAccount.findFirst({ where: { id: p.debitAccountId, tenantId, active: true } }), tx.glAccount.findFirst({ where: { id: p.creditAccountId, tenantId, active: true } })])
      const ref = (a: { code: string; name: string; type: string } | null): GlAccountRef | undefined => (a ? { code: a.code, name: a.name, type: a.type as GlAccountTypeName } : undefined)
      const problem = mappingProblem(ref(debit), ref(credit))
      if (problem) throw refuse(409, problem, GL_CHART_FAILURE.badMapping)
      const latest = await tx.glCategoryMapping.findFirst({ where: { tenantId, category: p.category }, orderBy: { version: 'desc' } })
      const row = latest && latest.debitAccountId === p.debitAccountId && latest.creditAccountId === p.creditAccountId
        ? latest
        : await tx.glCategoryMapping.create({ data: { tenantId, category: p.category, version: (latest?.version ?? 0) + 1, debitAccountId: p.debitAccountId, creditAccountId: p.creditAccountId, createdById: userId } })
      if (row !== latest) {
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.chart.mapping_set', entityType: 'gl_category_mapping', entityId: row.id, payload: sanitizeAuditPayload({
          category: p.category, version: row.version, debit: debit!.code, credit: credit!.code, previousVersion: latest?.version ?? null,
        }) } })
      }
      return {
        category: p.category, description: GL_CATEGORY_DESCRIPTIONS[p.category], version: row.version,
        debit: { id: debit!.id, code: debit!.code, name: debit!.name }, credit: { id: credit!.id, code: credit!.code, name: credit!.name },
      }
    })
  }

  /** The balanced journal of one closed month, per currency, with the checks that tie it to the period close record. */
  async journal(tenantId: string, query: Record<string, unknown>): Promise<GlJournalView> {
    const month = parseMonth(query.month)
    const range = monthRange(month)
    if (!range) throw refuse(400, 'month must be a calendar month written YYYY-MM', GL_CHART_FAILURE.invalid)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [close, chart] = await Promise.all([tx.financePeriodClose.findFirst({ where: { tenantId, periodStart: range.start } }), this.chart(tx, tenantId)])
      if (!close) throw refuse(409, 'The journal is built for a closed month only; close the period first.', GL_CHART_FAILURE.periodNotClosed)
      if (chart.unmappedCategories.length > 0) throw refuse(409, `Map these categories to accounts first: ${chart.unmappedCategories.join(', ')}`, GL_CHART_FAILURE.incomplete, { categories: chart.unmappedCategories })
      const mapping = Object.fromEntries(chart.mappings.map((m): [string, { debit: GlAccountRef; credit: GlAccountRef }] => {
        const ref = (a: { code: string; name: string }, type: GlAccountTypeName): GlAccountRef => ({ code: a.code, name: a.name, type })
        const type = (code: string) => chart.accounts.find(x => x.code === code)!.type
        return [m.category, { debit: ref(m.debit, type(m.debit.code)), credit: ref(m.credit, type(m.credit.code)) }]
      })) as GlMapping
      const fold = new GlFold()
      const { capped } = await foldLedgerRange(tx, tenantId, range, e => fold.add({ type: e.type, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, idempotencyKey: e.idempotencyKey }))
      if (capped) throw refuse(409, 'The month has too many entries for one journal; export it in parts.', GL_CHART_FAILURE.tooLarge)
      const journal = buildJournal(fold.result(), mapping)
      const recorded = close.totals as unknown as Array<{ currency: string; entries: number; movementMinor: string }>
      const recordedEntries = recorded.reduce((s, t) => s + t.entries, 0)
      const ties = recordedEntries === fold.entries && recorded.every(t => (fold.netByCurrency.get(t.currency) ?? 0n) === BigInt(t.movementMinor)) && [...fold.netByCurrency.entries()].every(([c, v]) => v === 0n || recorded.some(t => t.currency === c))
      const groups = fold.result()
      return {
        month, periodStart: day(range.start), periodEnd: day(range.end), mappingVersions: Object.fromEntries(chart.mappings.map(m => [m.category, m.version])),
        lines: journal.lines.map(l => ({ currency: l.currency, category: l.category, direction: l.direction, entries: l.entries, amountMinor: l.amountMinor.toString(), debit: l.debit.code, debitName: l.debit.name, credit: l.credit.code, creditName: l.credit.name })),
        accountTotals: journal.accountTotals.map(t => ({ currency: t.currency, accountCode: t.account.code, accountName: t.account.name, debitMinor: t.debitMinor.toString(), creditMinor: t.creditMinor.toString() })),
        balanced: journal.balanced, tiesToClose: ties, entries: fold.entries, unmappedEntries: fold.unmapped,
        otherCreditEntries: groups.filter(g => g.category === 'OTHER_CREDIT').reduce((s, g) => s + g.positiveCount + g.negativeCount, 0), generatedAt: new Date().toISOString(),
      }
    })
  }

  /**
   * The journal of a closed month as a CSV file (ADR 0103). Refused unless the journal is complete: every entry categorised, debits equal to credits in every currency and the totals equal to
   * those recorded at period close. Each download writes a `finance.journal.exported` audit event with the SHA-256 of the exact file, before the file is handed out.
   */
  async exportJournal(tenantId: string, userId: string, requestId: string, query: Record<string, unknown>): Promise<{ name: string; csv: string; sha256: string; rows: number; suspenseEntries: number }> {
    const kind: GlJournalExportKind = enumParam<GlJournalExportKind>('kind', query.kind, GL_JOURNAL_EXPORT_KINDS) ?? 'lines'
    const journal = await this.journal(tenantId, query)
    const problems = [journal.unmappedEntries > 0 && 'UNMAPPED_ENTRIES', !journal.balanced && 'NOT_BALANCED', !journal.tiesToClose && 'DOES_NOT_TIE_TO_CLOSE'].filter((p): p is string => typeof p === 'string')
    if (problems.length > 0) throw refuse(409, `This journal is not complete enough to export: ${problems.join(', ')}.`, GL_CHART_FAILURE.notExportable, { problems })
    const csv = kind === 'lines' ? journalLinesCsv(journal.month, journal.lines, journal.mappingVersions) : journalTotalsCsv(journal.month, journal.accountTotals)
    const sha256 = createHash('sha256').update(csv).digest('hex')
    const rows = (kind === 'lines' ? journal.lines : journal.accountTotals).length
    await this.prisma.withTenant(tenantId, tx => tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.journal.exported', entityType: 'gl_journal', entityId: journal.month, payload: sanitizeAuditPayload({
      requestId, month: journal.month, kind, rows, sha256, mappingVersions: journal.mappingVersions, suspenseEntries: journal.otherCreditEntries,
    }) } }))
    return { name: `gl-journal-${journal.month}-${kind}.csv`, csv, sha256, rows, suspenseEntries: journal.otherCreditEntries }
  }
}
