import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BankMatchFinding, BankStatement } from '@prisma/client'
import {
  BANK_EXCEPTION_STATUSES, BANK_MATCH_TYPE_NAMES, BANK_RESOLUTIONS, RECONCILIATION_DISABLED_CODE,
  type BankExceptionResolveRequest, type BankExceptionView, type BankImportFormat, type BankMatchSummaryView, type BankResolution, type BankStatementDetail, type BankStatementImportResult, type BankStatementView, type Paged,
} from '@bedbanks/contracts'
import { isBankException, matchBankStatement, type BankMatchType, type ExpectedPayment } from '@bedbanks/money'
import { ReconciliationStore } from './reconciliation-store'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enumParam, idParam, pageParams, paged } from '../admin-operations/query-params'
import { prepareBankImport, type PreparedBankImport } from './bank-import'
import { reconciliationEnabled } from './reconciliation.service'

const INSERT_BATCH = 1000
/** Expected payments are loaded for the statement period plus this many days either side: a payment can clear days after it was made, and a declared value date can be a little off. Only payments dated inside the period are reported missing. */
const WINDOW_DAYS = 60
/** More expected payments than this in one window is refused rather than silently truncated: a partial candidate set would report false exceptions. */
const MAX_EXPECTED = 20_000
const DAY_MS = 86_400_000

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const day = (d: Date) => d.toISOString().slice(0, 10)
const big = (v: bigint | null) => (v === null ? null : v.toString())
const dayDate = (s: string) => new Date(`${s}T00:00:00.000Z`)

export const BANK_DEFINITIONS: Record<string, string> = {
  MATCHED: 'Reference, direction, currency and amount agree with a recorded payment.',
  AMOUNT_MISMATCH: 'The reference matches a recorded payment but the bank moved a different amount.',
  CURRENCY_MISMATCH: 'The reference matches a recorded payment in another currency. Nothing is converted and no variance is computed.',
  DIRECTION_MISMATCH: 'The reference matches a recorded payment but the money moved the other way.',
  AMBIGUOUS_REFERENCE: 'The movement carries a reference that belongs to more than one recorded payment.',
  DUPLICATE_ENTRY: 'The same movement appears twice on the statement.',
  DUPLICATE_PAYMENT: 'A second movement carries the reference of a payment that was already matched.',
  UNMATCHED_ENTRY: 'No recorded payment carries this movement\'s reference (the suspense list).',
  EXPECTED_NOT_ON_STATEMENT: 'A recorded payment dated inside the statement period does not appear on it.',
}

function reasonOf(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('reason is required (3 to 500 characters)')
  const r = value.trim()
  if (r.length < 3 || r.length > 500 || /[\u0000-\u001f\u007f]/.test(r)) throw new BadRequestException('reason must be 3 to 500 printable characters')
  return r
}

type FindingRow = BankMatchFinding & { statement: { statementRef: string }; entry: { entryRef: string; direction: 'CREDIT' | 'DEBIT' } | null }

/**
 * Bank statement import, matching and the exception queue (ADR 0093).
 *
 * Matching runs inside the import: the pure matcher is in-memory and bounded by the statement size, so there is no queue to drain. The statement, its entries, its
 * findings and the audit event are written in ONE tenant transaction. Closing an exception is a conditional update on the state that was read, by a different person
 * than whoever imported the statement (also a database CHECK). Nothing here posts to the ledger, a wallet or a payable, and no currency is converted.
 */
@Injectable()
export class BankReconciliationService {
  constructor(private readonly prisma: ReconciliationStore) {}

  private assertEnabled() {
    if (!reconciliationEnabled()) throw new ServiceUnavailableException({ message: 'Finance reconciliation is not enabled on this deployment.', code: RECONCILIATION_DISABLED_CODE })
  }

  // ---- views ------------------------------------------------------------------------------------------------------------
  private async statementViews(tx: Prisma.TransactionClient, tenantId: string, rows: BankStatement[]): Promise<BankStatementView[]> {
    const ids = rows.map((r) => r.id)
    const counts = ids.length ? await tx.bankMatchFinding.groupBy({ by: ['statementId', 'isException', 'status'], where: { tenantId, statementId: { in: ids } }, _count: { _all: true } }) : []
    return rows.map((r) => {
      const n = (isException: boolean, status?: string) => counts.filter((c) => c.statementId === r.id && c.isException === isException && (status === undefined || c.status === status)).reduce((a, c) => a + c._count._all, 0)
      return {
        id: r.id, format: r.format as BankImportFormat, statementRef: r.statementRef, accountLast4: r.accountLast4, currency: r.currency, periodStart: day(r.periodStart), periodEnd: day(r.periodEnd),
        openingMinor: big(r.openingMinor), closingMinor: big(r.closingMinor), entryCount: r.entryCount, importedById: r.importedById, importedAt: r.createdAt.toISOString(),
        matched: n(false), exceptions: { open: n(true, 'OPEN'), resolved: n(true, 'RESOLVED') },
      }
    })
  }

  private async summary(tx: Prisma.TransactionClient, tenantId: string, statementId: string): Promise<BankMatchSummaryView[]> {
    const [byType, unmatched] = await Promise.all([
      tx.bankMatchFinding.groupBy({ by: ['currency', 'isException'], where: { tenantId, statementId }, _count: { _all: true }, _sum: { bankMinor: true } }),
      tx.bankStatementEntry.groupBy({ by: ['currency', 'direction'], where: { tenantId, statementId, findings: { some: { type: 'UNMATCHED_ENTRY' } } }, _sum: { amountMinor: true } }),
    ])
    const currencies = [...new Set([...byType.map((r) => r.currency), ...unmatched.map((r) => r.currency)])].sort()
    return currencies.map((currency) => {
      const row = (isException: boolean) => byType.find((r) => r.currency === currency && r.isException === isException)
      const un = (direction: string) => unmatched.find((r) => r.currency === currency && r.direction === direction)?._sum.amountMinor ?? 0n
      return { currency, matched: row(false)?._count._all ?? 0, exceptions: row(true)?._count._all ?? 0, matchedMinor: (row(false)?._sum.bankMinor ?? 0n).toString(), unmatchedCreditMinor: un('CREDIT').toString(), unmatchedDebitMinor: un('DEBIT').toString() }
    })
  }

  private exceptionView(r: FindingRow, me: string): BankExceptionView {
    return {
      id: r.id, statementId: r.statementId, statementRef: r.statement.statementRef, type: r.type, hint: BANK_DEFINITIONS[r.type] ?? '', status: r.status, currency: r.currency,
      bankMinor: big(r.bankMinor), expectedMinor: big(r.expectedMinor), varianceMinor: big(r.varianceMinor), entryRef: r.entry?.entryRef ?? null, direction: r.entry?.direction ?? null,
      expectedKind: r.expectedKind as BankExceptionView['expectedKind'], expectedId: r.expectedId, resolution: r.resolution as BankResolution | null, resolutionReason: r.resolutionReason,
      resolvedById: r.resolvedById, resolvedAt: iso(r.resolvedAt), createdAt: r.createdAt.toISOString(), canResolve: r.status === 'OPEN' && r.isException && r.raisedById !== me,
    }
  }

  private readonly findingInclude = { statement: { select: { statementRef: true } }, entry: { select: { entryRef: true, direction: true } } } as const

  // ---- reads ------------------------------------------------------------------------------------------------------------
  async listStatements(tenantId: string, query: Record<string, unknown>): Promise<Paged<BankStatementView>> {
    const page = pageParams(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.bankStatement.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.bankStatement.count({ where: { tenantId } }),
      ])
      return paged(await this.statementViews(tx, tenantId, rows), page, total)
    })
  }

  async getStatement(tenantId: string, statementId: string): Promise<BankStatementDetail> {
    const id = idParam('statementId', statementId)
    if (!id) throw new BadRequestException('statementId is required')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.bankStatement.findFirst({ where: { id, tenantId } })
      if (!row) throw new NotFoundException('Bank statement not found')
      const [[statement], summary] = await Promise.all([this.statementViews(tx, tenantId, [row]), this.summary(tx, tenantId, id)])
      return { statement, summary, definitions: BANK_DEFINITIONS }
    })
  }

  async listExceptions(tenantId: string, me: string, query: Record<string, unknown>): Promise<Paged<BankExceptionView>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, BANK_EXCEPTION_STATUSES)
    const type = enumParam('type', query.type, BANK_MATCH_TYPE_NAMES.filter((t) => t !== 'MATCHED'))
    const statementId = idParam('statementId', query.statementId)
    const where: Prisma.BankMatchFindingWhereInput = { tenantId, isException: true, ...(status && { status }), ...(type && { type }), ...(statementId && { statementId }) }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.bankMatchFinding.findMany({ where, include: this.findingInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.bankMatchFinding.count({ where }),
      ])
      return paged((rows as FindingRow[]).map((r) => this.exceptionView(r, me)), page, total)
    })
  }

  // ---- import -----------------------------------------------------------------------------------------------------------
  async importStatement(tenantId: string, userId: string, body: unknown): Promise<BankStatementImportResult> {
    this.assertEnabled()
    const prepared = prepareBankImport(tenantId, body)

    const replay = async (): Promise<BankStatementImportResult | null> => this.prisma.withTenant(tenantId, async (tx) => {
      // The requestId is the idempotency key, so it is checked first; only then is the same content under another request an error.
      const existing = await tx.bankStatement.findFirst({ where: { tenantId, requestId: prepared.requestId } })
      if (!existing) {
        const sameContent = await tx.bankStatement.findFirst({ where: { tenantId, contentSha256: prepared.contentSha256 }, select: { id: true } })
        if (sameContent) throw new ConflictException({ message: 'This statement content was already imported', code: 'BANK_STATEMENT_DUPLICATE_CONTENT' })
        return null
      }
      if (existing.contentSha256 !== prepared.contentSha256) throw new ConflictException({ message: 'This requestId was already used for a different statement', code: 'BANK_REQUEST_REUSED' })
      const [view] = await this.statementViews(tx, tenantId, [existing])
      return { statement: view, summary: await this.summary(tx, tenantId, existing.id), replayed: true }
    })

    const earlier = await replay()
    if (earlier) return earlier
    try {
      return await this.prisma.withTenant(tenantId, (tx) => this.persist(tx, tenantId, userId, prepared), { timeoutMs: 60_000 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await replay()
        if (raced) return raced
        throw new ConflictException({ message: 'A statement with this number was already imported for this account', code: 'BANK_STATEMENT_REF_EXISTS' })
      }
      throw error
    }
  }

  private async expectedPayments(tx: Prisma.TransactionClient, tenantId: string, p: PreparedBankImport): Promise<ExpectedPayment[]> {
    const from = new Date(dayDate(p.periodStart).getTime() - WINDOW_DAYS * DAY_MS)
    const to = new Date(dayDate(p.periodEnd).getTime() + WINDOW_DAYS * DAY_MS)
    const [settlements, receipts] = await Promise.all([
      tx.supplierSettlement.findMany({ where: { tenantId, status: 'APPROVED', paidOn: { gte: from, lte: to } }, select: { id: true, paymentReference: true, currency: true, amountMinor: true, paidOn: true }, take: MAX_EXPECTED + 1 }),
      tx.$queryRaw<Array<{ id: string; currency: string; amount_minor: bigint; bank_reference: string; value_date: Date }>>(Prisma.sql`SELECT "id", "currency", "amount_minor", "bank_reference", "value_date" FROM fbeds_bank_expected_receipts(${from}::date, ${to}::date, ${MAX_EXPECTED + 1}::integer)`),
    ])
    if (settlements.length + receipts.length > MAX_EXPECTED) throw new UnprocessableEntityException({ message: 'Too many recorded payments in the statement window to match safely; import a shorter period', code: 'BANK_EXPECTED_SET_TOO_LARGE' })
    return [
      ...settlements.map((s): ExpectedPayment => ({ id: s.id, kind: 'SUPPLIER_SETTLEMENT', reference: s.paymentReference, currency: s.currency, amountMinor: s.amountMinor, direction: 'DEBIT', date: day(s.paidOn) })),
      ...receipts.map((r): ExpectedPayment => ({ id: r.id, kind: 'FUNDING_RECEIPT', reference: r.bank_reference, currency: r.currency, amountMinor: r.amount_minor, direction: 'CREDIT', date: day(r.value_date) })),
    ]
  }

  private async persist(tx: Prisma.TransactionClient, tenantId: string, userId: string, p: PreparedBankImport): Promise<BankStatementImportResult> {
    const expected = await this.expectedPayments(tx, tenantId, p)
    const prior = expected.length
      ? new Set((await tx.bankMatchFinding.findMany({ where: { tenantId, type: 'MATCHED', expectedId: { in: expected.map((e) => e.id) } }, select: { expectedId: true } })).map((f) => f.expectedId as string))
      : new Set<string>()
    const result = matchBankStatement(p.entries, expected, { from: p.periodStart, to: p.periodEnd }, prior)

    const statement = await tx.bankStatement.create({ data: {
      tenantId, format: p.format, statementRef: p.statementRef, accountSha256: p.accountSha256, accountLast4: p.accountLast4, currency: p.currency, periodStart: dayDate(p.periodStart), periodEnd: dayDate(p.periodEnd),
      openingMinor: p.openingMinor, closingMinor: p.closingMinor, entryCount: p.entries.length, contentSha256: p.contentSha256, requestId: p.requestId, importedById: userId,
    } })
    // Batched so one statement never builds a single multi-thousand-row INSERT (PostgreSQL allows 32,767 bind parameters per statement).
    const entryIds = new Map<number, string>()
    for (let at = 0; at < p.entries.length; at += INSERT_BATCH) {
      const rows = await tx.bankStatementEntry.createManyAndReturn({
        data: p.entries.slice(at, at + INSERT_BATCH).map((e, i) => ({ tenantId, statementId: statement.id, entryNo: at + i + 1, entryRef: e.entryRef.slice(0, 200), direction: e.direction, currency: e.currency, amountMinor: e.amountMinor, bookingDate: dayDate(e.bookingDate), valueDate: dayDate(e.valueDate) })),
        select: { id: true, entryNo: true },
      })
      for (const r of rows) entryIds.set(r.entryNo, r.id)
    }
    for (let at = 0; at < result.findings.length; at += INSERT_BATCH) {
      await tx.bankMatchFinding.createMany({ data: result.findings.slice(at, at + INSERT_BATCH).map((f) => ({
        tenantId, statementId: statement.id, findingKey: f.key, entryId: f.key.startsWith('entry:') ? (entryIds.get(Number(f.key.slice(6))) ?? null) : null, type: f.type as BankMatchType, isException: isBankException(f.type),
        currency: f.currency, bankMinor: f.bankMinor, expectedMinor: f.expectedMinor, varianceMinor: f.varianceMinor, expectedKind: f.expectedKind, expectedId: f.expectedId, raisedById: userId,
      })) })
    }
    const exceptions = result.findings.filter((f) => isBankException(f.type)).length
    await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'finance.bank_reconciliation.statement_imported', entityType: 'bank_statement', entityId: statement.id, payload: sanitizeAuditPayload({
      format: p.format, entries: p.entries.length, periodStart: p.periodStart, periodEnd: p.periodEnd, currency: p.currency, matched: result.findings.length - exceptions, exceptions, contentSha256: p.contentSha256,
    }) }] })
    const [view] = await this.statementViews(tx, tenantId, [statement])
    return { statement: view, summary: await this.summary(tx, tenantId, statement.id), replayed: false }
  }

  // ---- exceptions -------------------------------------------------------------------------------------------------------
  async resolveException(tenantId: string, userId: string, exceptionId: string, body: BankExceptionResolveRequest): Promise<BankExceptionView> {
    this.assertEnabled()
    const id = idParam('exceptionId', exceptionId)
    if (!id) throw new BadRequestException('exceptionId is required')
    const b = (body ?? {}) as Partial<BankExceptionResolveRequest>
    if (typeof b.resolution !== 'string' || !(BANK_RESOLUTIONS as readonly string[]).includes(b.resolution)) throw new BadRequestException(`resolution must be one of ${BANK_RESOLUTIONS.join(', ')}`)
    const reason = reasonOf(b.reason)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.bankMatchFinding.findFirst({ where: { id, tenantId }, include: this.findingInclude })
      if (!before) throw new NotFoundException('Exception not found')
      if (!before.isException) throw new ConflictException({ message: 'A clean match has nothing to resolve', code: 'BANK_NOT_AN_EXCEPTION' })
      if (before.status !== 'OPEN') throw new ConflictException({ message: 'This exception is already resolved', code: 'BANK_EXCEPTION_RESOLVED' })
      if (before.raisedById === userId) throw new ForbiddenException({ message: 'The person who imported the statement cannot close its exceptions', code: 'BANK_SEPARATION_OF_DUTIES' })
      const moved = await tx.bankMatchFinding.updateMany({ where: { id, tenantId, status: 'OPEN' }, data: { status: 'RESOLVED', resolution: b.resolution, resolutionReason: reason, resolvedById: userId, resolvedAt: new Date() } })
      if (moved.count !== 1) throw new ConflictException({ message: 'This exception changed while you were deciding; reload it', code: 'BANK_EXCEPTION_CHANGED' })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'finance.bank_reconciliation.exception_resolved', entityType: 'bank_match_finding', entityId: id, payload: sanitizeAuditPayload({
        statementId: before.statementId, type: before.type, resolution: b.resolution, currency: before.currency, bankMinor: big(before.bankMinor), expectedMinor: big(before.expectedMinor), varianceMinor: big(before.varianceMinor), expectedKind: before.expectedKind, expectedId: before.expectedId, reason,
      }) }] })
      const after = await tx.bankMatchFinding.findFirstOrThrow({ where: { id, tenantId }, include: this.findingInclude })
      return this.exceptionView(after as FindingRow, userId)
    })
  }
}
