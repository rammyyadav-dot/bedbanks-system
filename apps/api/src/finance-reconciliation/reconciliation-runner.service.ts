import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { isException, reconcileStatement, type Finding, type StatementLineInput } from '@bedbanks/money'
import { RECON_AUTO_RESOLUTION } from '@bedbanks/contracts'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { planSync, type StoredFinding } from './finding-sync'
import { loadLedgerScope, ScopeTooLargeError } from './ledger-items'
import { ReconciliationStore } from './reconciliation-store'

export const MAX_RUN_ATTEMPTS = 3
/** A RUNNING claim older than this is treated as abandoned and re-driven. Keep equal to the interval in fbeds_reconciliation_due_tenants(). */
export const STALE_CLAIM_MS = 10 * 60_000
/** A 5000-line statement is read, matched and written in one transaction; the Prisma default of five seconds is too tight. */
const RUN_TRANSACTION_TIMEOUT_MS = 120_000

class LostClaimError extends Error {
  constructor() { super('LOST_CLAIM'); this.name = 'LostClaimError' }
}

export type ClaimOutcome = { kind: 'claimed'; runId: string; claimedAt: Date } | { kind: 'none' } | { kind: 'skipped' }
export type RunOutcome = 'SUCCEEDED' | 'RETRY' | 'FAILED' | 'LOST'

export interface RunCounts { matched: number; exceptions: number; created: number; refreshed: number; autoResolved: number; reopened: number }

/**
 * Executes reconciliation runs (ADR 0070). This is the whole job: the HTTP service only inserts a QUEUED run, and the worker (or a test) calls `drain`.
 *
 * Claim: a conditional update (QUEUED -> RUNNING, or a stale RUNNING) on the exact status and attempt count read, so concurrent workers cannot both win.
 * Execute: one tenant transaction reads the statement and the ledger scope, matches, persists findings and marks the run SUCCEEDED; if the claim was lost
 * meanwhile the transaction rolls back. A failure is recorded outside that transaction: retried up to MAX_RUN_ATTEMPTS, then FAILED with a stable code only.
 * The run's audit events are attributed to the user who requested it, because ordinary roles may not insert SYSTEM-actor audit events (migration 202609180002).
 * Nothing here writes LedgerEntry or Wallet, converts currency or posts a payable.
 */
@Injectable()
export class ReconciliationRunner {
  private readonly logger = new Logger(ReconciliationRunner.name)

  constructor(private readonly prisma: ReconciliationStore) {}

  async claimNext(tenantId: string, now: Date = new Date()): Promise<ClaimOutcome> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS)
    return this.prisma.withTenant(tenantId, async (tx): Promise<ClaimOutcome> => {
      const candidate = await tx.reconciliationRun.findFirst({
        where: { tenantId, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', claimedAt: { lt: staleBefore } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (!candidate) return { kind: 'none' }
      const same = { id: candidate.id, tenantId, status: candidate.status, attempts: candidate.attempts }
      if (candidate.attempts >= MAX_RUN_ATTEMPTS) {
        await tx.reconciliationRun.updateMany({ where: same, data: { status: 'FAILED', finishedAt: now, errorCode: 'MAX_ATTEMPTS' } })
        return { kind: 'skipped' }
      }
      const won = await tx.reconciliationRun.updateMany({ where: same, data: { status: 'RUNNING', claimedAt: now, startedAt: now, attempts: { increment: 1 } } })
      return won.count === 1 ? { kind: 'claimed', runId: candidate.id, claimedAt: now } : { kind: 'skipped' }
    })
  }

  /** Claims and executes queued runs of one tenant, oldest first. Returns how many runs it processed. */
  async drain(tenantId: string, max = 10, now: () => Date = () => new Date()): Promise<number> {
    let processed = 0
    while (processed < max) {
      const claim = await this.claimNext(tenantId, now())
      if (claim.kind === 'none') break
      if (claim.kind === 'skipped') { processed += 1; continue }
      await this.execute(tenantId, claim.runId, claim.claimedAt)
      processed += 1
    }
    return processed
  }

  async execute(tenantId: string, runId: string, claimedAt: Date): Promise<RunOutcome> {
    try {
      const counts = await this.prisma.withTenant(tenantId, (tx) => this.perform(tx, tenantId, runId, claimedAt), { timeoutMs: RUN_TRANSACTION_TIMEOUT_MS })
      this.logger.log(`Reconciliation run ${runId} succeeded: matched=${counts.matched} exceptions=${counts.exceptions}`)
      return 'SUCCEEDED'
    } catch (error) {
      if (error instanceof LostClaimError) return 'LOST'
      const code = error instanceof ScopeTooLargeError ? 'SCOPE_TOO_LARGE' : 'RUN_ERROR'
      this.logger.error(`Reconciliation run ${runId} failed: ${error instanceof Error ? error.name : 'unknown error'} (${code})`)
      return this.recordFailure(tenantId, runId, claimedAt, code)
    }
  }

  private async recordFailure(tenantId: string, runId: string, claimedAt: Date, code: string): Promise<RunOutcome> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const run = await tx.reconciliationRun.findFirst({ where: { id: runId, tenantId } })
      if (!run || run.status !== 'RUNNING' || run.claimedAt?.getTime() !== claimedAt.getTime()) return 'LOST'
      const retry = code === 'RUN_ERROR' && run.attempts < MAX_RUN_ATTEMPTS
      const moved = await tx.reconciliationRun.updateMany({
        where: { id: runId, tenantId, status: 'RUNNING', claimedAt },
        data: retry ? { status: 'QUEUED', startedAt: null } : { status: 'FAILED', finishedAt: new Date(), errorCode: code },
      })
      if (moved.count !== 1) return 'LOST'
      await tx.auditEvent.createMany({ data: [{ tenantId, userId: run.requestedById, actorType: 'USER', action: retry ? 'finance.reconciliation.run_retry' : 'finance.reconciliation.run_failed', entityType: 'reconciliation_run', entityId: runId, payload: sanitizeAuditPayload({ statementId: run.statementId, errorCode: code, attempts: run.attempts, source: 'reconciliation_worker' }) }] })
      return retry ? 'RETRY' : 'FAILED'
    })
  }

  private async perform(tx: Prisma.TransactionClient, tenantId: string, runId: string, claimedAt: Date): Promise<RunCounts> {
    const run = await tx.reconciliationRun.findFirst({ where: { id: runId, tenantId } })
    if (!run || run.status !== 'RUNNING' || run.claimedAt?.getTime() !== claimedAt.getTime()) throw new LostClaimError()
    const statement = await tx.supplierStatement.findFirst({ where: { id: run.statementId, tenantId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
    if (!statement) throw new Error('STATEMENT_MISSING')

    const scope = await loadLedgerScope(tx, { tenantId, supplierId: statement.supplierId, statementId: statement.id, periodStart: statement.periodStart, periodEnd: statement.periodEnd, references: statement.lines.map((l) => l.reference) })
    const lines: StatementLineInput[] = statement.lines.map((l) => ({ lineId: l.id, reference: l.reference, kind: l.kind, currency: l.currency, amountMinor: l.amountMinor }))
    const result = reconcileStatement(lines, scope.items, { roundingToleranceMinor: run.roundingToleranceMinor })
    // A ledger-side gap is only meaningful for a booking the supplier was expected to invoice in this period.
    const findings = result.findings.filter((f) => f.lineId !== null || (f.bookingId !== null && scope.inPeriod.has(f.bookingId)))

    const now = new Date()
    const existingRows = await tx.reconciliationFinding.findMany({ where: { tenantId, statementId: statement.id } })
    const existing: StoredFinding[] = existingRows.map((r) => ({ id: r.id, findingKey: r.findingKey, status: r.status, isException: r.isException, type: r.type, bookingId: r.bookingId, currency: r.currency, statementMinor: r.statementMinor, ledgerMinor: r.ledgerMinor, varianceMinor: r.varianceMinor }))
    const ops = planSync(existing, findings)
    const rowById = new Map(existingRows.map((r) => [r.id, r]))
    const counts: RunCounts = { matched: findings.filter((f) => !isException(f.type)).length, exceptions: findings.filter((f) => isException(f.type)).length, created: 0, refreshed: 0, autoResolved: 0, reopened: 0 }

    const factsOf = (f: Finding) => ({ type: f.type, rule: f.rule, bookingId: f.bookingId, isException: isException(f.type), currency: f.currency, statementMinor: f.statementMinor, ledgerMinor: f.ledgerMinor, varianceMinor: f.varianceMinor })
    const decisions: Prisma.ReconciliationDecisionCreateManyInput[] = []
    const creates: Prisma.ReconciliationFindingCreateManyInput[] = []
    for (const op of ops) {
      if (op.op === 'create') {
        const clean = !isException(op.finding.type)
        creates.push({ tenantId, statementId: statement.id, supplierId: statement.supplierId, findingKey: op.finding.key, lineId: op.finding.lineId, ...factsOf(op.finding), status: clean ? 'RESOLVED' : 'OPEN', resolvedAt: clean ? now : null, lastRunId: run.id })
        counts.created += 1
      } else if (op.op === 'refresh') {
        const before = rowById.get(op.id)!
        const data: Prisma.ReconciliationFindingUncheckedUpdateInput = { ...factsOf(op.finding), lastRunId: run.id }
        if (op.autoResolve) Object.assign(data, { status: 'RESOLVED', resolution: RECON_AUTO_RESOLUTION, resolvedAt: now })
        else if (op.reopen) Object.assign(data, { status: 'OPEN', proposedAction: null, proposedById: null, proposedReason: null, secondApprovalRequired: false })
        await tx.reconciliationFinding.update({ where: { id: op.id, tenantId }, data })
        counts.refreshed += 1
        if (op.autoResolve) { counts.autoResolved += 1; decisions.push({ tenantId, findingId: op.id, action: 'AUTO_RESOLVED', fromStatus: before.status, toStatus: 'RESOLVED', resolution: RECON_AUTO_RESOLUTION, reason: 'The difference no longer exists after re-matching', actorId: null }) }
        else if (op.reopen) { counts.reopened += 1; decisions.push({ tenantId, findingId: op.id, action: 'REOPENED_FACTS_CHANGED', fromStatus: before.status, toStatus: 'OPEN', reason: 'The facts changed after the decision was proposed', actorId: null }) }
      } else if (op.op === 'autoResolve') {
        const before = rowById.get(op.id)!
        await tx.reconciliationFinding.update({ where: { id: op.id, tenantId }, data: { status: 'RESOLVED', resolution: RECON_AUTO_RESOLUTION, resolvedAt: now, lastRunId: run.id } })
        counts.autoResolved += 1
        decisions.push({ tenantId, findingId: op.id, action: 'AUTO_RESOLVED', fromStatus: before.status, toStatus: 'RESOLVED', resolution: RECON_AUTO_RESOLUTION, reason: 'No longer applies after re-matching', actorId: null })
      }
    }
    if (creates.length) await tx.reconciliationFinding.createMany({ data: creates })
    if (decisions.length) await tx.reconciliationDecision.createMany({ data: decisions })

    const done = await tx.reconciliationRun.updateMany({ where: { id: run.id, tenantId, status: 'RUNNING', claimedAt }, data: { status: 'SUCCEEDED', finishedAt: now, matchedCount: counts.matched, exceptionCount: counts.exceptions, errorCode: null } })
    if (done.count !== 1) throw new LostClaimError()
    await tx.auditEvent.createMany({ data: [{ tenantId, userId: run.requestedById, actorType: 'USER', action: 'finance.reconciliation.run_completed', entityType: 'reconciliation_run', entityId: run.id, payload: sanitizeAuditPayload({ statementId: statement.id, supplierId: statement.supplierId, ...counts, source: 'reconciliation_worker' }) }] })
    return counts
  }
}
