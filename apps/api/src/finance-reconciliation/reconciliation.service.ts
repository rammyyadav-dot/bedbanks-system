import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { ReconciliationDecision, ReconciliationFinding, ReconciliationRun, SupplierStatement } from '@prisma/client'
import {
  RECONCILIATION_DISABLED_CODE, RECON_EXCEPTION_STATUSES, RECON_FINDING_TYPES, RECON_RESOLUTION_ACTIONS,
  type Paged, type ReconDecisionRequest, type ReconDecisionView, type ReconExceptionDetail, type ReconExceptionSummary, type ReconExceptionView, type ReconProposeRequest,
  type ReconResolution, type ReconResolutionAction, type ReconRunRequest, type ReconRunView, type ReconSeverity, type SettlementRow, type StatementDetail, type StatementImportRequest, type StatementView,
} from '@bedbanks/contracts'
import { EXCEPTION_RULES, isException, type FindingType } from '@bedbanks/money'
import { ReconciliationStore } from './reconciliation-store'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enumParam, idParam, pageParams, paged, textParam } from '../admin-operations/query-params'
import { allowedActions, approve, propose, reject, secondApprovalByAction, type Refusal, type Transition, type WorkflowSubject } from './exception-workflow'
import { validateStatementImport, type ValidStatement } from './statement-import'
import { parseStatementStream } from './statement-stream'
import { ReconciliationWorker } from './reconciliation-worker.service'

/** Write endpoints stay off until the deployment opts in (and has provisioned the finance-gated write role). Reads always work. */
export const reconciliationEnabled = (env: NodeJS.ProcessEnv = process.env) => env.FINANCE_RECONCILIATION_ENABLED === 'true'

const MAX_TOLERANCE_MINOR = 1000n
const STATEMENT_INSERT_BATCH = 1000
const SUPPLIER = { select: { id: true, displayName: true } } as const
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const day = (d: Date) => d.toISOString().slice(0, 10)
const big = (v: bigint | null) => (v === null ? null : v.toString())

function reasonOf(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('reason is required (3 to 500 characters)')
  const r = value.trim()
  if (r.length < 3 || r.length > 500 || /[\u0000-\u001f\u007f]/.test(r)) throw new BadRequestException('reason must be 3 to 500 printable characters')
  return r
}

function severityOf(type: FindingType): ReconSeverity {
  return isException(type) ? EXCEPTION_RULES[type as keyof typeof EXCEPTION_RULES].severity : 'LOW'
}
const typesWithSeverity = (severity: ReconSeverity) => RECON_FINDING_TYPES.filter((t) => isException(t as FindingType) && severityOf(t as FindingType) === severity)

function refuse(r: Refusal): never {
  if (r.status === 403) throw new ForbiddenException({ message: r.message, code: r.code })
  if (r.status === 422) throw new BadRequestException({ message: r.message, code: r.code })
  throw new ConflictException({ message: r.message, code: r.code })
}

type FindingRow = ReconciliationFinding & { statement: { statementRef: string }; supplier: { id: string; displayName: string }; booking: { id: string; reference: string } | null }

/**
 * Supplier statement import, run requests and the dispute queue (ADR 0070).
 *
 * Every mutation is permission-gated by the controller, needs the deployment flag, and writes its state change, its decision row and its audit event in ONE tenant
 * transaction. Decisions are conditional updates on the state that was read, so two people cannot both win. Nothing here posts to the ledger, a wallet or a payable.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: ReconciliationStore, @Optional() private readonly worker?: ReconciliationWorker) {}

  private assertEnabled() {
    if (!reconciliationEnabled()) throw new ServiceUnavailableException({ message: 'Finance reconciliation is not enabled on this deployment.', code: RECONCILIATION_DISABLED_CODE })
  }

  // ---- views ------------------------------------------------------------------------------------------------------------
  private runView(r: ReconciliationRun): ReconRunView {
    return {
      id: r.id, statementId: r.statementId, status: r.status, roundingToleranceMinor: r.roundingToleranceMinor.toString(), requestedById: r.requestedById, requestedAt: r.createdAt.toISOString(),
      startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), attempts: r.attempts, errorCode: r.errorCode, matched: r.matchedCount, exceptions: r.exceptionCount,
    }
  }

  private async statementViews(tx: Prisma.TransactionClient, tenantId: string, rows: Array<SupplierStatement & { supplier: { id: string; displayName: string } }>): Promise<StatementView[]> {
    const ids = rows.map((r) => r.id)
    const [runs, counts] = ids.length ? await Promise.all([
      tx.reconciliationRun.findMany({ where: { tenantId, statementId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      tx.reconciliationFinding.groupBy({ by: ['statementId', 'status'], where: { tenantId, statementId: { in: ids }, isException: true }, _count: { _all: true } }),
    ]) : [[], []]
    return rows.map((r) => {
      const c = (status: string) => counts.find((x) => x.statementId === r.id && x.status === status)?._count._all ?? 0
      const latest = runs.find((x) => x.statementId === r.id)
      return {
        id: r.id, supplier: r.supplier, statementRef: r.statementRef, periodStart: day(r.periodStart), periodEnd: day(r.periodEnd), lineCount: r.lineCount, importedById: r.importedById, importedAt: r.createdAt.toISOString(),
        latestRun: latest ? this.runView(latest) : null, exceptions: { open: c('OPEN'), disputed: c('DISPUTED'), pendingApproval: c('PENDING_APPROVAL'), resolved: c('RESOLVED') },
      }
    })
  }

  private async exceptionViews(tx: Prisma.TransactionClient, tenantId: string, me: string, rows: FindingRow[]): Promise<ReconExceptionView[]> {
    const lineIds = rows.map((r) => r.lineId).filter((x): x is string => x !== null)
    const lines = lineIds.length ? await tx.supplierStatementLine.findMany({ where: { tenantId, id: { in: lineIds } }, select: { id: true, lineNo: true, reference: true } }) : []
    const lineOf = new Map(lines.map((l) => [l.id, l]))
    return rows.map((r) => {
      const line = r.lineId ? lineOf.get(r.lineId) : undefined
      const rule = isException(r.type) ? EXCEPTION_RULES[r.type as keyof typeof EXCEPTION_RULES] : null
      return {
        id: r.id, statementId: r.statementId, statementRef: r.statement.statementRef, supplier: r.supplier, type: r.type, severity: severityOf(r.type), hint: rule?.hint ?? '', status: r.status, currency: r.currency,
        statementMinor: big(r.statementMinor), ledgerMinor: big(r.ledgerMinor), varianceMinor: big(r.varianceMinor), reference: line?.reference ?? null, lineNo: line?.lineNo ?? null, booking: r.booking,
        allowedActions: allowedActions(r.type, r.varianceMinor), proposedAction: (r.proposedAction as ReconResolutionAction | null), proposedById: r.proposedById,
        resolution: r.resolution as ReconResolution | null, resolvedById: r.resolvedById, resolvedAt: iso(r.resolvedAt), createdAt: r.createdAt.toISOString(),
        canPropose: r.status === 'OPEN' || r.status === 'DISPUTED', canDecide: r.status === 'PENDING_APPROVAL' && r.proposedById !== me,
      }
    })
  }

  private readonly findingInclude = { statement: { select: { statementRef: true } }, supplier: SUPPLIER, booking: { select: { id: true, reference: true } } } as const

  // ---- statements -------------------------------------------------------------------------------------------------------
  async listStatements(tenantId: string, query: Record<string, unknown>): Promise<Paged<StatementView>> {
    const page = pageParams(query)
    const supplierId = idParam('supplierId', query.supplierId)
    const where: Prisma.SupplierStatementWhereInput = { tenantId, ...(supplierId && { supplierId }) }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.supplierStatement.findMany({ where, include: { supplier: SUPPLIER }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.supplierStatement.count({ where }),
      ])
      return paged(await this.statementViews(tx, tenantId, rows), page, total)
    })
  }

  async getStatement(tenantId: string, statementId: string): Promise<StatementDetail> {
    const id = idParam('statementId', statementId)
    if (!id) throw new BadRequestException('statementId is required')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.supplierStatement.findFirst({ where: { id, tenantId }, include: { supplier: SUPPLIER } })
      if (!row) throw new NotFoundException('Statement not found')
      const [[view], runs, byKind, byOutcome] = await Promise.all([
        this.statementViews(tx, tenantId, [row]),
        tx.reconciliationRun.findMany({ where: { tenantId, statementId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10 }),
        tx.supplierStatementLine.groupBy({ by: ['currency', 'kind'], where: { tenantId, statementId: id }, _sum: { amountMinor: true } }),
        tx.reconciliationFinding.groupBy({ by: ['currency', 'isException'], where: { tenantId, statementId: id, lineId: { not: null } }, _sum: { statementMinor: true } }),
      ])
      const currencies = [...new Set(byKind.map((r) => r.currency))].sort()
      const settlement: SettlementRow[] = currencies.map((currency) => {
        const sum = (kind: string) => byKind.find((r) => r.currency === currency && r.kind === kind)?._sum.amountMinor ?? 0n
        const charges = sum('CHARGE') + sum('SURCHARGE')
        const credits = sum('CREDIT')
        const outcome = (flag: boolean) => byOutcome.find((r) => r.currency === currency && r.isException === flag)?._sum.statementMinor ?? 0n
        return { currency, chargesMinor: charges.toString(), creditsMinor: credits.toString(), statementNetMinor: (charges - credits).toString(), matchedMinor: outcome(false).toString(), exceptionMinor: outcome(true).toString() }
      })
      return {
        statement: view, runs: runs.map((r) => this.runView(r)), settlement,
        definitions: {
          statementNet: 'Charges plus surcharges minus credits on the statement, per currency. Currencies are never converted or added together.',
          matched: 'Amount on statement lines whose booking reference and net amount matched exactly. Exceptions are the lines a person must decide.',
          scope: 'Payable bookings of this supplier with check-out inside the statement period are expected on the statement; a booking with no supplier organization is out of scope.',
          money: 'Nothing here posts to the ledger or a payable. A decision is a recorded, audited intent.',
        },
      }
    })
  }

  async importStatement(tenantId: string, userId: string, body: StatementImportRequest): Promise<StatementView> {
    this.assertEnabled()
    return this.persistStatement(tenantId, userId, validateStatementImport(body))
  }

  /** Streamed upload (ADR 0074). The body is read and validated line by line before anything is written; idempotency and the content hash are the JSON import's. */
  async importStatementStream(tenantId: string, userId: string, source: AsyncIterable<Buffer | Uint8Array | string>): Promise<StatementView> {
    this.assertEnabled()
    return this.persistStatement(tenantId, userId, await parseStatementStream(source))
  }

  private async persistStatement(tenantId: string, userId: string, v: ValidStatement): Promise<StatementView> {
    const replay = async () => {
      const existing = await this.prisma.withTenant(tenantId, (tx) => tx.supplierStatement.findFirst({ where: { tenantId, requestId: v.requestId }, include: { supplier: SUPPLIER } }))
      if (!existing) return null
      if (existing.supplierId !== v.supplierId || existing.contentSha256 !== v.contentSha256 || existing.statementRef !== v.statementRef) {
        throw new ConflictException({ message: 'This requestId was already used for a different statement', code: 'RECON_REQUEST_REUSED' })
      }
      return existing
    }
    const earlier = await replay()
    if (earlier) return this.prisma.withTenant(tenantId, async (tx) => (await this.statementViews(tx, tenantId, [earlier]))[0])

    try {
      const created = await this.prisma.withTenant(tenantId, async (tx) => {
        const supplier = await tx.supplier.findFirst({ where: { id: v.supplierId, tenantId }, select: { id: true } })
        if (!supplier) throw new NotFoundException('Supplier not found')
        const statement = await tx.supplierStatement.create({
          data: { tenantId, supplierId: v.supplierId, statementRef: v.statementRef, periodStart: v.periodStart, periodEnd: v.periodEnd, lineCount: v.lines.length, contentSha256: v.contentSha256, requestId: v.requestId, importedById: userId },
          include: { supplier: SUPPLIER },
        })
        // Batched so one statement never builds a single multi-thousand-row INSERT (PostgreSQL allows 32,767 bind parameters per statement).
        for (let at = 0; at < v.lines.length; at += STATEMENT_INSERT_BATCH) {
          await tx.supplierStatementLine.createMany({ data: v.lines.slice(at, at + STATEMENT_INSERT_BATCH).map((l) => ({ tenantId, statementId: statement.id, lineNo: l.lineNo, reference: l.reference, kind: l.kind, currency: l.currency, amountMinor: l.amountMinor })) })
        }
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'finance.reconciliation.statement_imported', entityType: 'supplier_statement', entityId: statement.id, payload: sanitizeAuditPayload({ supplierId: v.supplierId, statementRef: v.statementRef, lines: v.lines.length, periodStart: day(v.periodStart), periodEnd: day(v.periodEnd), contentSha256: v.contentSha256 }) }] })
        return statement
      })
      return this.prisma.withTenant(tenantId, async (tx) => (await this.statementViews(tx, tenantId, [created]))[0])
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const raced = await replay()
      if (raced) return this.prisma.withTenant(tenantId, async (tx) => (await this.statementViews(tx, tenantId, [raced]))[0])
      const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '')
      if (target.includes('content_sha256')) throw new ConflictException({ message: 'This statement content was already imported under another number', code: 'RECON_STATEMENT_DUPLICATE_CONTENT' })
      throw new ConflictException({ message: 'A statement with this number was already imported for this supplier', code: 'RECON_STATEMENT_REF_EXISTS' })
    }
  }

  // ---- runs -------------------------------------------------------------------------------------------------------------
  async enqueueRun(tenantId: string, userId: string, statementId: string, body: ReconRunRequest): Promise<ReconRunView> {
    this.assertEnabled()
    const id = idParam('statementId', statementId)
    if (!id) throw new BadRequestException('statementId is required')
    if (!body || typeof body !== 'object' || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,80}$/.test(body.requestId)) throw new BadRequestException('requestId must be 8 to 80 characters (letters, digits, . _ : -)')
    let tolerance = 0n
    if (body.roundingToleranceMinor !== undefined) {
      if (typeof body.roundingToleranceMinor !== 'string' || !/^\d{1,4}$/.test(body.roundingToleranceMinor)) throw new BadRequestException('roundingToleranceMinor must be a whole number of minor units as a string')
      tolerance = BigInt(body.roundingToleranceMinor)
      if (tolerance > MAX_TOLERANCE_MINOR) throw new BadRequestException(`roundingToleranceMinor must not exceed ${MAX_TOLERANCE_MINOR}`)
    }
    const requestId = body.requestId
    const replay = async () => {
      const existing = await this.prisma.withTenant(tenantId, (tx) => tx.reconciliationRun.findFirst({ where: { tenantId, requestId } }))
      if (!existing) return null
      if (existing.statementId !== id || existing.roundingToleranceMinor !== tolerance) throw new ConflictException({ message: 'This requestId was already used for a different run', code: 'RECON_REQUEST_REUSED' })
      return existing
    }
    const earlier = await replay()
    if (earlier) return this.runView(earlier)
    try {
      const run = await this.prisma.withTenant(tenantId, async (tx) => {
        const statement = await tx.supplierStatement.findFirst({ where: { id, tenantId }, select: { id: true } })
        if (!statement) throw new NotFoundException('Statement not found')
        const active = await tx.reconciliationRun.count({ where: { tenantId, statementId: id, status: { in: ['QUEUED', 'RUNNING'] } } })
        if (active > 0) throw new ConflictException({ message: 'A run for this statement is already queued or running', code: 'RECON_RUN_IN_PROGRESS' })
        const created = await tx.reconciliationRun.create({ data: { tenantId, statementId: id, requestId, requestedById: userId, roundingToleranceMinor: tolerance } })
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'finance.reconciliation.run_requested', entityType: 'reconciliation_run', entityId: created.id, payload: sanitizeAuditPayload({ statementId: id, roundingToleranceMinor: tolerance.toString() }) }] })
        return created
      })
      this.worker?.kick(tenantId)
      return this.runView(run)
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const raced = await replay()
      if (raced) return this.runView(raced)
      throw error
    }
  }

  // ---- the dispute queue ------------------------------------------------------------------------------------------------
  async listExceptions(tenantId: string, me: string, query: Record<string, unknown>): Promise<Paged<ReconExceptionView>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, RECON_EXCEPTION_STATUSES)
    const type = enumParam('type', query.type, RECON_FINDING_TYPES)
    const severity = enumParam('severity', query.severity, ['LOW', 'MEDIUM', 'HIGH'] as const)
    const supplierId = idParam('supplierId', query.supplierId)
    const statementId = idParam('statementId', query.statementId)
    const currency = textParam('currency', query.currency, 3)
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('Invalid currency')
    const sort = enumParam('sort', query.sort, ['newest', 'oldest'] as const) ?? 'newest'
    if (type && !isException(type as FindingType)) throw new BadRequestException('Invalid type')
    const types = type ? [type] : severity ? typesWithSeverity(severity) : undefined
    const where: Prisma.ReconciliationFindingWhereInput = { tenantId, isException: true, ...(status && { status }), ...(types && { type: { in: types as never } }), ...(supplierId && { supplierId }), ...(statementId && { statementId }), ...(currency && { currency }) }
    const order = sort === 'oldest' ? 'asc' : 'desc'
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.reconciliationFinding.findMany({ where, include: this.findingInclude, orderBy: [{ createdAt: order }, { id: order }], skip: page.skip, take: page.take }),
        tx.reconciliationFinding.count({ where }),
      ])
      return paged(await this.exceptionViews(tx, tenantId, me, rows), page, total)
    })
  }

  async exceptionSummary(tenantId: string): Promise<ReconExceptionSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [byStatus, byType, open] = await Promise.all([
        tx.reconciliationFinding.groupBy({ by: ['status'], where: { tenantId, isException: true }, _count: { _all: true } }),
        tx.reconciliationFinding.groupBy({ by: ['type'], where: { tenantId, isException: true, status: { not: 'RESOLVED' } }, _count: { _all: true } }),
        tx.$queryRaw<Array<{ currency: string; total: bigint; unknown: number }>>`
          SELECT "currency", COALESCE(SUM(ABS("variance_minor")), 0)::bigint AS total, (COUNT(*) FILTER (WHERE "variance_minor" IS NULL))::int AS "unknown"
          FROM "ReconciliationFinding" WHERE "tenant_id" = ${tenantId} AND "is_exception" AND "status" <> 'RESOLVED' GROUP BY "currency" ORDER BY "currency"`,
      ])
      const statuses = { OPEN: 0, DISPUTED: 0, PENDING_APPROVAL: 0, RESOLVED: 0 }
      for (const r of byStatus) statuses[r.status] = r._count._all
      return {
        byStatus: statuses,
        byType: Object.fromEntries(byType.map((r) => [r.type, r._count._all])),
        openVarianceByCurrency: open.map((r) => ({ currency: r.currency, absoluteVarianceMinor: r.total.toString(), unknownAmountCount: r.unknown })),
      }
    })
  }

  private async loadFinding(tx: Prisma.TransactionClient, tenantId: string, exceptionId: string): Promise<FindingRow> {
    const id = idParam('exceptionId', exceptionId)
    if (!id) throw new BadRequestException('exceptionId is required')
    const row = await tx.reconciliationFinding.findFirst({ where: { id, tenantId, isException: true }, include: this.findingInclude })
    if (!row) throw new NotFoundException('Exception not found')
    return row
  }

  async getException(tenantId: string, me: string, exceptionId: string): Promise<ReconExceptionDetail> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await this.loadFinding(tx, tenantId, exceptionId)
      const [[exception], history] = await Promise.all([
        this.exceptionViews(tx, tenantId, me, [row]),
        tx.reconciliationDecision.findMany({ where: { tenantId, findingId: row.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      ])
      return { exception, history: history.map((h) => this.decisionView(h)), secondApprovalRequired: secondApprovalByAction(row) }
    })
  }

  private decisionView(h: ReconciliationDecision): ReconDecisionView {
    return { id: h.id, action: h.action, fromStatus: h.fromStatus, toStatus: h.toStatus, resolution: h.resolution as ReconResolution | null, reason: h.reason, actorId: h.actorId, createdAt: h.createdAt.toISOString() }
  }

  private subject(r: ReconciliationFinding): WorkflowSubject {
    return { status: r.status, type: r.type, currency: r.currency, statementMinor: r.statementMinor, ledgerMinor: r.ledgerMinor, varianceMinor: r.varianceMinor, proposedAction: r.proposedAction as ReconResolutionAction | null, proposedById: r.proposedById }
  }

  /** Applies a transition as a conditional update on the state that was read, with its decision row and audit event, in the caller's transaction. */
  private async apply(tx: Prisma.TransactionClient, tenantId: string, userId: string, before: FindingRow, next: Transition, action: string, reason: string): Promise<void> {
    const now = new Date()
    const proposing = action.startsWith('PROPOSE:')
    const moved = await tx.reconciliationFinding.updateMany({
      where: { id: before.id, tenantId, status: before.status, proposedById: before.proposedById },
      data: {
        status: next.to, proposedAction: next.proposedAction, proposedById: next.proposedById, secondApprovalRequired: next.secondApprovalRequired,
        ...(proposing && { proposedReason: reason }), ...(next.to === 'OPEN' && { proposedReason: null }),
        resolution: next.resolution, resolvedById: next.resolvedById, resolvedAt: next.resolved ? now : null,
      },
    })
    if (moved.count !== 1) throw new ConflictException({ message: 'This exception changed while you were deciding; reload it', code: 'RECON_CONCURRENT_CHANGE' })
    await tx.reconciliationDecision.create({ data: { tenantId, findingId: before.id, action: action.replace('PROPOSE:', ''), fromStatus: before.status, toStatus: next.to, resolution: next.resolution, reason, actorId: userId } })
    await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: `finance.reconciliation.exception_${next.to === 'RESOLVED' ? 'resolved' : next.to === 'DISPUTED' ? 'disputed' : next.to === 'PENDING_APPROVAL' ? 'proposed' : 'reopened'}`, entityType: 'reconciliation_finding', entityId: before.id, payload: sanitizeAuditPayload({
      statementId: before.statementId, supplierId: before.supplierId, type: before.type, decision: action.replace('PROPOSE:', ''), from: before.status, to: next.to, currency: before.currency,
      statementMinor: big(before.statementMinor), ledgerMinor: big(before.ledgerMinor), varianceMinor: big(before.varianceMinor), secondApprovalRequired: next.secondApprovalRequired, reasonLength: reason.length,
    }) }] })
  }

  async proposeDecision(tenantId: string, userId: string, exceptionId: string, body: ReconProposeRequest): Promise<ReconExceptionDetail> {
    this.assertEnabled()
    if (!body || typeof body !== 'object') throw new BadRequestException('A decision is required')
    const action = enumParam('action', body.action, RECON_RESOLUTION_ACTIONS)
    if (!action) throw new BadRequestException('action is required')
    const reason = reasonOf(body.reason)
    await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await this.loadFinding(tx, tenantId, exceptionId)
      const next = propose(this.subject(row), action, userId)
      if (next.kind === 'refused') refuse(next)
      await this.apply(tx, tenantId, userId, row, next, `PROPOSE:${action}`, reason)
    })
    return this.getException(tenantId, userId, exceptionId)
  }

  async approveDecision(tenantId: string, userId: string, exceptionId: string, body: ReconDecisionRequest): Promise<ReconExceptionDetail> {
    this.assertEnabled()
    const reason = reasonOf(body?.reason)
    await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await this.loadFinding(tx, tenantId, exceptionId)
      const next = approve(this.subject(row), userId)
      if (next.kind === 'refused') refuse(next)
      await this.apply(tx, tenantId, userId, row, next, 'APPROVED', reason)
    })
    return this.getException(tenantId, userId, exceptionId)
  }

  async rejectDecision(tenantId: string, userId: string, exceptionId: string, body: ReconDecisionRequest): Promise<ReconExceptionDetail> {
    this.assertEnabled()
    const reason = reasonOf(body?.reason)
    await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await this.loadFinding(tx, tenantId, exceptionId)
      const next = reject(this.subject(row), userId)
      if (next.kind === 'refused') refuse(next)
      await this.apply(tx, tenantId, userId, row, next, 'REJECTED', reason)
    })
    return this.getException(tenantId, userId, exceptionId)
  }
}
