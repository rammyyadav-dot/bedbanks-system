import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LedgerAdjustment } from '@prisma/client'
import {
  LEDGER_ADJUSTMENT_FAILURE, LEDGER_ADJUSTMENT_STATUSES, LEDGER_ADJUSTMENT_KINDS,
  type LedgerAdjustmentKindName, type LedgerAdjustmentReasonName, type LedgerAdjustmentStatusName, type LedgerAdjustmentView, type Paged,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { appendLedgerEntry, walletBalanceMinor } from '../ledger/ledger-core'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enumParam, idParam, pageParams, paged } from '../admin-operations/query-params'
import { parseAdjustmentDecisionReason, parseLedgerAdjustmentProposal } from './adjustment-input'

const refuse = (status: 400 | 403 | 404 | 409 | 503, message: string, code: string) => {
  const body = { message, code }
  if (status === 403) return new ForbiddenException(body)
  if (status === 404) return new NotFoundException(body)
  if (status === 409) return new ConflictException(body)
  if (status === 503) return new ServiceUnavailableException(body)
  return new BadRequestException(body)
}

/** A financial refusal whose audit must survive the rollback of the transaction that detected it (ADR 0113). */
class AdjustmentRefusal extends Error {
  constructor(
    readonly http: BadRequestException | ForbiddenException | NotFoundException | ConflictException | ServiceUnavailableException,
    readonly action: string,
    readonly entityType: string,
    readonly entityId: string,
    readonly payload: Record<string, unknown>,
  ) {
    super('ledger adjustment refused')
  }
}
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const abs = (v: bigint) => (v < 0n ? -v : v)

type Row = LedgerAdjustment & { agency: { name: string } }
const INCLUDE = { agency: { select: { name: true } } } as const

interface ReceiptRow { id: string; status: string; agency_id: string; currency: string; amount_minor: bigint; wallet_id: string | null }

/**
 * Ledger adjustments and reversals on agency accounts (ADR 0100).
 *
 * Proposing records intent and moves no money. Approving, by a different person, posts exactly one ADJUSTMENT or REVERSAL to the agency account in the same transaction that marks the
 * record approved, under the receipt row lock (REVERSAL only) and then the wallet row lock, the order the funding post uses. A REVERSAL names the POSTED funding receipt it takes back and can
 * never take back more than that receipt paid, counting proposals still waiting, so two proposals cannot over-reverse together. Idempotent: the entry is keyed
 * `adjustment:<id>` or `funding:<receipt>:reversal:<id>` and the record links its entry (unique). Runs on the API connection like the credit note service, because the booking module's
 * role has no ledger access (ADR 0032). Writes need LEDGER_ADJUSTMENTS_ENABLED=true. An approved debit may leave the account below its credit line; that is a credit-control warning in the
 * integrity report (ACCOUNT_OVER_CREDIT_LINE), not a reason to refuse a payment that really was recalled.
 *
 * Every proposal, approval and rejection writes an audit event in the same transaction. A refusal that rolls that transaction back (the proposer deciding their own record, a reversal
 * above what the receipt still has, a reused request) is written afterwards, so the attempt remains visible. The note stays on the adjustment row and is not copied into the audit payload.
 */
@Injectable()
export class LedgerAdjustmentService {
  constructor(private readonly prisma: PrismaService) {}

  private assertEnabled(env: NodeJS.ProcessEnv = process.env) {
    if (env.LEDGER_ADJUSTMENTS_ENABLED !== 'true') throw refuse(503, 'Ledger adjustments are not enabled on this deployment.', LEDGER_ADJUSTMENT_FAILURE.disabled)
  }

  /** Persists a refusal after the detecting transaction has rolled back. A failure to write the audit does not hide the refusal. */
  private async persistRefusal(tenantId: string, userId: string, refusal: AdjustmentRefusal) {
    await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: {
      tenantId, userId, actorType: 'USER', action: refusal.action, entityType: refusal.entityType, entityId: refusal.entityId,
      payload: sanitizeAuditPayload({ outcome: 'denied', ...refusal.payload }),
    } })).catch(() => undefined)
  }

  private audited(status: 400 | 403 | 404 | 409, message: string, code: string, audit: { action?: string; entityType: string; entityId: string; payload: Record<string, unknown> }): never {
    throw new AdjustmentRefusal(refuse(status, message, code), audit.action ?? 'finance.ledger_adjustment.denied', audit.entityType, audit.entityId, { code, ...audit.payload })
  }

  private facts(row: { kind: string; agencyId: string; currency: string; amountMinor: bigint; reason: string; fundingReceiptId: string | null }) {
    return {
      kind: row.kind, agencyId: row.agencyId, reason: row.reason, currency: row.currency,
      direction: row.amountMinor < 0n ? 'DEBIT' : 'CREDIT', amountMinor: abs(row.amountMinor).toString(),
      ...(row.fundingReceiptId && { fundingReceiptId: row.fundingReceiptId }),
    }
  }

  private view(r: Row, me: string): LedgerAdjustmentView {
    return {
      id: r.id, kind: r.kind as LedgerAdjustmentKindName, agencyId: r.agencyId, agencyName: r.agency.name, currency: r.currency, direction: r.amountMinor < 0n ? 'DEBIT' : 'CREDIT', amountMinor: abs(r.amountMinor).toString(),
      reason: r.reason as LedgerAdjustmentReasonName, note: r.note, fundingReceiptId: r.fundingReceiptId, status: r.status as LedgerAdjustmentStatusName, proposedById: r.proposedById, proposedAt: r.createdAt.toISOString(),
      decidedById: r.decidedById, decidedAt: iso(r.decidedAt), decisionReason: r.decisionReason, ledgerEntryId: r.ledgerEntryId, canDecide: r.status === 'PROPOSED' && r.proposedById !== me,
    }
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<Paged<LedgerAdjustmentView>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, LEDGER_ADJUSTMENT_STATUSES)
    const kind = enumParam('kind', query.kind, LEDGER_ADJUSTMENT_KINDS)
    const agencyId = idParam('agencyId', query.agencyId)
    const where: Prisma.LedgerAdjustmentWhereInput = { tenantId, ...(status && { status }), ...(kind && { kind }), ...(agencyId && { agencyId }) }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.ledgerAdjustment.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.ledgerAdjustment.count({ where }),
      ])
      return paged(rows.map((r) => this.view(r as Row, me)), page, total)
    })
  }

  /** Locks the receipt row and checks it is a POSTED receipt of this agency and currency. Caller is inside a tenant transaction. A posted-status or ownership failure is audited. */
  private async lockReceipt(tx: Prisma.TransactionClient, tenantId: string, receiptId: string, agencyId: string, currency: string, attempt: Record<string, unknown>): Promise<ReceiptRow> {
    const rows = await tx.$queryRaw<ReceiptRow[]>(Prisma.sql`SELECT "id", "status"::text AS "status", "agency_id", "currency", "amount_minor", "wallet_id" FROM "FundingReceipt" WHERE "id" = ${receiptId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
    const receipt = rows[0]
    if (!receipt) throw refuse(404, 'Funding receipt not found', LEDGER_ADJUSTMENT_FAILURE.receiptNotFound)
    if (receipt.status !== 'POSTED') this.audited(409, `Only a posted funding receipt can be reversed (this one is ${receipt.status}).`, LEDGER_ADJUSTMENT_FAILURE.receiptNotPosted, { entityType: 'funding_receipt', entityId: receiptId, payload: { ...attempt, receiptStatus: receipt.status } })
    if (receipt.agency_id !== agencyId || receipt.currency !== currency) this.audited(409, 'The receipt belongs to another agency or currency.', LEDGER_ADJUSTMENT_FAILURE.receiptMismatch, { entityType: 'funding_receipt', entityId: receiptId, payload: { ...attempt, receiptAgencyId: receipt.agency_id, receiptCurrency: receipt.currency } })
    return receipt
  }

  async propose(tenantId: string, userId: string, body: unknown): Promise<LedgerAdjustmentView> {
    this.assertEnabled()
    const p = parseLedgerAdjustmentProposal(body)
    const attempt = { kind: p.kind, agencyId: p.agencyId, reason: p.reason, currency: p.currency, direction: p.direction, amountMinor: abs(p.signedAmountMinor).toString(), requestId: p.requestId, ...(p.fundingReceiptId && { fundingReceiptId: p.fundingReceiptId }) }
    try {
      return await this.proposeOnce(tenantId, userId, p, attempt)
    } catch (error) {
      if (error instanceof AdjustmentRefusal) {
        await this.persistRefusal(tenantId, userId, error)
        throw error.http
      }
      throw error
    }
  }

  private async proposeOnce(tenantId: string, userId: string, p: ReturnType<typeof parseLedgerAdjustmentProposal>, attempt: Record<string, unknown>): Promise<LedgerAdjustmentView> {
    const replay = async () => {
      const existing = await this.prisma.withTenant(tenantId, (tx) => tx.ledgerAdjustment.findFirst({ where: { tenantId, requestId: p.requestId }, include: INCLUDE }))
      if (!existing) return null
      if (existing.kind !== p.kind || existing.agencyId !== p.agencyId || existing.currency !== p.currency || existing.amountMinor !== p.signedAmountMinor || existing.reason !== p.reason || existing.fundingReceiptId !== p.fundingReceiptId) {
        this.audited(409, 'This requestId was already used for a different adjustment', LEDGER_ADJUSTMENT_FAILURE.requestReused, { entityType: 'ledger_adjustment', entityId: existing.id, payload: attempt })
      }
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: {
        tenantId, userId, actorType: 'USER', action: 'finance.ledger_adjustment.replayed', entityType: 'ledger_adjustment', entityId: existing.id,
        payload: sanitizeAuditPayload({ outcome: 'replayed', ...attempt }),
      } })).catch(() => undefined)
      return this.view(existing as Row, userId)
    }
    const earlier = await replay()
    if (earlier) return earlier
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const agency = await tx.agency.findFirst({ where: { id: p.agencyId, tenantId }, select: { id: true } })
        if (!agency) throw refuse(404, 'Agency not found', LEDGER_ADJUSTMENT_FAILURE.agencyNotFound)
        const wallet = await tx.wallet.findFirst({ where: { tenantId, agencyId: p.agencyId, currency: p.currency }, select: { id: true } })
        if (!wallet) this.audited(409, `The agency has no ${p.currency} account to adjust`, LEDGER_ADJUSTMENT_FAILURE.noAccount, { entityType: 'agency', entityId: p.agencyId, payload: attempt })
        let reversibleMinor: bigint | null = null
        if (p.kind === 'REVERSAL') {
          const receipt = await this.lockReceipt(tx, tenantId, p.fundingReceiptId as string, p.agencyId, p.currency, attempt)
          if (receipt.wallet_id !== wallet.id) this.audited(409, 'The receipt was posted to a different account.', LEDGER_ADJUSTMENT_FAILURE.receiptMismatch, { entityType: 'funding_receipt', entityId: receipt.id, payload: { ...attempt, walletId: wallet.id, receiptWalletId: receipt.wallet_id } })
          const taken = await tx.ledgerAdjustment.aggregate({ where: { tenantId, fundingReceiptId: receipt.id, status: { in: ['PROPOSED', 'APPROVED'] } }, _sum: { amountMinor: true } })
          reversibleMinor = receipt.amount_minor + (taken._sum.amountMinor ?? 0n)
          if (abs(p.signedAmountMinor) > reversibleMinor) {
            this.audited(409, 'The reversal exceeds the part of the receipt not yet reversed or already proposed for reversal.', LEDGER_ADJUSTMENT_FAILURE.exceedsReceipt, { entityType: 'funding_receipt', entityId: receipt.id, payload: { ...attempt, reversibleMinor: reversibleMinor.toString() } })
          }
        }
        const created = await tx.ledgerAdjustment.create({
          data: { tenantId, agencyId: p.agencyId, walletId: wallet.id, kind: p.kind, currency: p.currency, amountMinor: p.signedAmountMinor, reason: p.reason, note: p.note, fundingReceiptId: p.fundingReceiptId, requestId: p.requestId, proposedById: userId },
          include: INCLUDE,
        })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.ledger_adjustment.proposed', entityType: 'ledger_adjustment', entityId: created.id, payload: sanitizeAuditPayload({
          outcome: 'proposed', proposedById: userId, walletId: wallet.id,
          ...attempt,
          ...(p.fundingReceiptId && { reversibleBeforeMinor: (reversibleMinor ?? 0n).toString() }),
        }) } })
        return this.view(created as Row, userId)
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await replay()
        if (raced) return raced
      }
      throw error
    }
  }

  async approve(tenantId: string, userId: string, adjustmentId: string): Promise<LedgerAdjustmentView> {
    this.assertEnabled()
    const id = idParam('adjustmentId', adjustmentId)
    if (!id) throw refuse(400, 'adjustmentId is required', LEDGER_ADJUSTMENT_FAILURE.invalid)
    try {
      return await this.decide(tenantId, userId, id, 'approve')
    } catch (error) {
      if (error instanceof AdjustmentRefusal) {
        await this.persistRefusal(tenantId, userId, error)
        throw error.http
      }
      throw error
    }
  }

  async reject(tenantId: string, userId: string, adjustmentId: string, body: unknown): Promise<LedgerAdjustmentView> {
    this.assertEnabled()
    const id = idParam('adjustmentId', adjustmentId)
    if (!id) throw refuse(400, 'adjustmentId is required', LEDGER_ADJUSTMENT_FAILURE.invalid)
    const reason = parseAdjustmentDecisionReason(body)
    try {
      return await this.decide(tenantId, userId, id, 'reject', reason)
    } catch (error) {
      if (error instanceof AdjustmentRefusal) {
        await this.persistRefusal(tenantId, userId, error)
        throw error.http
      }
      throw error
    }
  }

  private async decide(tenantId: string, userId: string, id: string, decision: 'approve' | 'reject', decisionReason?: string): Promise<LedgerAdjustmentView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const found = await tx.ledgerAdjustment.findFirst({ where: { id, tenantId } })
      if (!found) throw refuse(404, 'Adjustment not found', LEDGER_ADJUSTMENT_FAILURE.notFound)
      if (found.status !== 'PROPOSED') throw refuse(409, 'This adjustment is already decided', LEDGER_ADJUSTMENT_FAILURE.decided)
      if (found.proposedById === userId) {
        this.audited(403, decision === 'approve' ? 'The person who proposed an adjustment cannot approve it' : 'The person who proposed an adjustment cannot reject it; withdraw it by asking another finance user', LEDGER_ADJUSTMENT_FAILURE.ownProposal, {
          action: 'approval.denied', entityType: 'ledger_adjustment', entityId: id,
          payload: { ...this.facts(found), approvalAction: decision === 'approve' ? 'finance.adjustment.approve' : 'finance.adjustment.reject', adjustmentReason: found.reason, reason: 'SELF_APPROVAL' },
        })
      }

      if (decision === 'reject') {
        const moved = await tx.ledgerAdjustment.updateMany({ where: { id, tenantId, status: 'PROPOSED' }, data: { status: 'REJECTED', decidedById: userId, decidedAt: new Date(), decisionReason } })
        if (moved.count !== 1) throw refuse(409, 'This adjustment changed while you were deciding; reload it', LEDGER_ADJUSTMENT_FAILURE.changed)
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.ledger_adjustment.rejected', entityType: 'ledger_adjustment', entityId: id, payload: sanitizeAuditPayload({
          outcome: 'rejected', proposedById: found.proposedById, decidedById: userId, decisionReason, ...this.facts(found),
        }) } })
        const after = await tx.ledgerAdjustment.findFirstOrThrow({ where: { id, tenantId }, include: INCLUDE })
        return this.view(after as Row, userId)
      }

      let reference = `adjustment:${found.id}`
      let idempotencyKey = `adjustment:${found.id}`
      if (found.kind === 'REVERSAL') {
        const receiptId = found.fundingReceiptId as string
        const receipt = await this.lockReceipt(tx, tenantId, receiptId, found.agencyId, found.currency, this.facts(found))
        // Proposals still waiting are not counted here: each is checked when its own turn comes, under the same receipt lock.
        const approved = await tx.ledgerAdjustment.aggregate({ where: { tenantId, fundingReceiptId: receiptId, status: 'APPROVED' }, _sum: { amountMinor: true } })
        const remaining = receipt.amount_minor + (approved._sum.amountMinor ?? 0n)
        if (abs(found.amountMinor) > remaining) {
          this.audited(409, 'The reversal now exceeds the part of the receipt not yet reversed (another reversal was approved since it was proposed).', LEDGER_ADJUSTMENT_FAILURE.exceedsReceipt, {
            entityType: 'ledger_adjustment', entityId: id, payload: { ...this.facts(found), remainingMinor: remaining.toString() },
          })
        }
        reference = `funding:${receiptId}`
        idempotencyKey = `funding:${receiptId}:reversal:${found.id}`
      }
      const wallet = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${found.walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (wallet.length !== 1) throw refuse(409, 'The agency account could not be locked', LEDGER_ADJUSTMENT_FAILURE.changed)

      const balanceBefore = await walletBalanceMinor(tx, tenantId, found.walletId, found.currency)
      const entry = await appendLedgerEntry(tx, { tenantId, walletId: found.walletId, type: found.kind, amountMinor: found.amountMinor, currency: found.currency, reference, idempotencyKey })
      const moved = await tx.ledgerAdjustment.updateMany({ where: { id, tenantId, status: 'PROPOSED' }, data: { status: 'APPROVED', decidedById: userId, decidedAt: new Date(), ledgerEntryId: entry.id } })
      if (moved.count !== 1) throw refuse(409, 'This adjustment changed while you were deciding; reload it', LEDGER_ADJUSTMENT_FAILURE.changed)
      const balanceAfter = await walletBalanceMinor(tx, tenantId, found.walletId, found.currency)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.ledger_adjustment.approved', entityType: 'ledger_adjustment', entityId: id, payload: sanitizeAuditPayload({
        outcome: 'posted', proposedById: found.proposedById, decidedById: userId, ...this.facts(found),
        walletId: found.walletId, ledgerEntryId: entry.id, idempotencyKey, reference, balanceBeforeMinor: balanceBefore.toString(), balanceAfterMinor: balanceAfter.toString(),
      }) } })
      const after = await tx.ledgerAdjustment.findFirstOrThrow({ where: { id, tenantId }, include: INCLUDE })
      return this.view(after as Row, userId)
    })
  }
}
