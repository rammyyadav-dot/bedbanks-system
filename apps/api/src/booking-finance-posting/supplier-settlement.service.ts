import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { SETTLEMENT_FAILURE, type SettlementDecisionRequest, type SettlementListView, type SettlementProposeRequest, type SettlementStatus, type SettlementView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'

export const SETTLEMENT_LIST_LIMIT = 100
const DATE = /^\d{4}-\d{2}-\d{2}$/
const bad = (message: string, code: string = SETTLEMENT_FAILURE.invalid) => new BadRequestException({ message, code })
const conflict = (message: string, code: string) => new ConflictException({ message, code })

const COLUMNS = { id: true, supplierId: true, currency: true, amountMinor: true, paidOn: true, paymentReference: true, note: true, status: true, requestId: true, proposedById: true, decidedById: true, decidedAt: true, decisionReason: true, createdAt: true } as const
type Row = Prisma.SupplierSettlementGetPayload<{ select: typeof COLUMNS }>

const iso = (d: Date) => d.toISOString().slice(0, 10)
const view = (r: Row, supplierName: string | null): SettlementView => ({
  id: r.id, supplierId: r.supplierId, supplierName, currency: r.currency, amountMinor: r.amountMinor.toString(), paidOn: iso(r.paidOn), paymentReference: r.paymentReference, note: r.note,
  status: r.status as SettlementStatus, proposedById: r.proposedById, proposedAt: r.createdAt.toISOString(), decidedById: r.decidedById, decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason,
})

/** Validates and normalises a proposal. Pure, so every refusal is unit-tested without a database. */
export function parseProposal(body: unknown, now: Date): { supplierId: string; currency: string; amountMinor: bigint; paidOn: Date; paymentReference: string; note: string | null; requestId: string } {
  if (!body || typeof body !== 'object') throw bad('A request body is required')
  const b = body as Record<string, unknown>
  const text = (name: string) => (typeof b[name] === 'string' ? (b[name] as string).trim() : '')
  const supplierId = text('supplierId')
  if (!supplierId) throw bad('supplierId is required')
  const currency = text('currency')
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('currency must be an ISO-4217 alpha code')
  const amount = typeof b.amountMinor === 'string' ? b.amountMinor.trim() : ''
  if (!/^[1-9]\d{0,17}$/.test(amount)) throw bad('amountMinor must be a positive whole number of minor units (digits only)')
  const paidRaw = text('paidOn')
  const paidOn = new Date(`${paidRaw}T00:00:00.000Z`)
  if (!DATE.test(paidRaw) || Number.isNaN(paidOn.getTime()) || iso(paidOn) !== paidRaw) throw bad('paidOn must be a real date as YYYY-MM-DD')
  if (paidOn.getTime() > now.getTime()) throw bad('paidOn cannot be in the future')
  const paymentReference = text('paymentReference')
  if (paymentReference.length < 3 || paymentReference.length > 80) throw bad('paymentReference must be 3 to 80 characters')
  const note = b.note === undefined || b.note === null ? null : typeof b.note === 'string' ? b.note.trim() : undefined
  if (note === undefined || (note !== null && note.length > 500)) throw bad('note must be text of at most 500 characters')
  const requestId = text('requestId')
  if (requestId.length < 8 || requestId.length > 80) throw bad('requestId must be 8 to 80 characters')
  return { supplierId, currency, amountMinor: BigInt(amount), paidOn, paymentReference, note: note || null, requestId }
}


/**
 * Supplier settlements (ADR 0077): a payment made to a supplier outside the system, recorded against its posted payables. Maker-checker: one person proposes, a different person
 * approves or rejects. Nothing here moves money or touches the agency ledger. Runs on the consumer's own role (the API role has no grant on these tables); an unavailable role is
 * the typed 503. A payment can never exceed what is still owed to that supplier in that currency, counting proposals still waiting, so two proposals cannot overpay together.
 */
@Injectable()
export class SupplierSettlementService {
  constructor(private readonly db: BookingFinancePostingDatabase, private readonly prisma: PrismaService, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  /** Writes are off until the deployment sets SUPPLIER_SETTLEMENT_ENABLED=true (reads always work). */
  private assertEnabled(): void {
    if (this.env.SUPPLIER_SETTLEMENT_ENABLED !== 'true') throw new ServiceUnavailableException({ message: 'Supplier settlements are not enabled in this deployment', code: SETTLEMENT_FAILURE.disabled })
  }

  /** What can still be paid: posted payables less approved and pending settlements, for one supplier and currency. Caller holds the lock. */
  private async available(tx: Prisma.TransactionClient, tenantId: string, supplierId: string, currency: string, excludeId?: string): Promise<{ owed: bigint; committed: bigint }> {
    const [owed, committed] = await Promise.all([
      tx.supplierPayableEntry.aggregate({ where: { tenantId, supplierId, currency }, _sum: { amountMinor: true } }),
      tx.supplierSettlement.aggregate({ where: { tenantId, supplierId, currency, status: { in: ['PROPOSED', 'APPROVED'] }, ...(excludeId ? { id: { not: excludeId } } : {}) }, _sum: { amountMinor: true } }),
    ])
    return { owed: owed._sum.amountMinor ?? 0n, committed: committed._sum.amountMinor ?? 0n }
  }

  private lock(tx: Prisma.TransactionClient, supplierId: string, currency: string) {
    return tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supplier-settlement:${supplierId}:${currency}`}, 0))`)
  }

  private audit(tx: Prisma.TransactionClient, tenantId: string, userId: string, action: string, r: Row, requestId: string) {
    return tx.auditEvent.createMany({ data: [{
      tenantId, userId, actorType: 'USER', action, entityType: 'supplier_settlement', entityId: r.id,
      payload: { supplierId: r.supplierId, currency: r.currency, amountMinor: r.amountMinor.toString(), paymentReference: r.paymentReference, settlementRequestId: r.requestId, requestId, ...(r.decisionReason ? { reasonGiven: true } : {}) },
    }] })
  }

  private async name(tenantId: string, supplierId: string): Promise<string | null> {
    return (await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { displayName: true } })))?.displayName ?? null
  }

  async propose(tenantId: string, userId: string, body: SettlementProposeRequest, requestContextId: string, now = new Date()): Promise<SettlementView> {
    this.assertEnabled()
    const p = parseProposal(body, now)
    const supplierName = await this.name(tenantId, p.supplierId)
    if (supplierName === null) throw new NotFoundException({ message: 'Supplier not found', code: SETTLEMENT_FAILURE.unknownSupplier })
    const row = await this.db.withTenant(tenantId, async (tx) => {
      await this.lock(tx, p.supplierId, p.currency)
      const replay = await tx.supplierSettlement.findUnique({ where: { tenantId_requestId: { tenantId, requestId: p.requestId } }, select: COLUMNS })
      if (replay) {
        const same = replay.supplierId === p.supplierId && replay.currency === p.currency && replay.amountMinor === p.amountMinor && iso(replay.paidOn) === iso(p.paidOn) && replay.paymentReference === p.paymentReference && replay.note === p.note
        if (!same) throw conflict('This requestId was already used for a different settlement', SETTLEMENT_FAILURE.idempotencyConflict)
        return replay
      }
      if (await tx.supplierSettlement.findUnique({ where: { tenantId_supplierId_paymentReference: { tenantId, supplierId: p.supplierId, paymentReference: p.paymentReference } }, select: { id: true } })) {
        throw conflict('A settlement with this payment reference is already recorded for this supplier', SETTLEMENT_FAILURE.duplicateReference)
      }
      const { owed, committed } = await this.available(tx, tenantId, p.supplierId, p.currency)
      if (p.amountMinor > owed - committed) throw conflict(`The amount exceeds what is still owed to this supplier in ${p.currency}`, SETTLEMENT_FAILURE.exceedsOwed)
      const created = await tx.supplierSettlement.create({ data: { tenantId, supplierId: p.supplierId, currency: p.currency, amountMinor: p.amountMinor, paidOn: p.paidOn, paymentReference: p.paymentReference, note: p.note, requestId: p.requestId, proposedById: userId }, select: COLUMNS })
      await this.audit(tx, tenantId, userId, 'finance.settlement.proposed', created, requestContextId)
      return created
    })
    return view(row, supplierName)
  }

  async approve(tenantId: string, userId: string, settlementId: string, requestContextId: string, now = new Date()): Promise<SettlementView> {
    this.assertEnabled()
    const row = await this.decide(tenantId, userId, settlementId, requestContextId, now, 'APPROVED', null)
    return view(row, await this.name(tenantId, row.supplierId))
  }

  async reject(tenantId: string, userId: string, settlementId: string, body: SettlementDecisionRequest, requestContextId: string, now = new Date()): Promise<SettlementView> {
    this.assertEnabled()
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3 || reason.length > 500) throw bad('A reason of 3 to 500 characters is required to reject a settlement')
    const row = await this.decide(tenantId, userId, settlementId, requestContextId, now, 'REJECTED', reason)
    return view(row, await this.name(tenantId, row.supplierId))
  }

  private decide(tenantId: string, userId: string, settlementId: string, requestContextId: string, now: Date, to: 'APPROVED' | 'REJECTED', reason: string | null): Promise<Row> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.supplierSettlement.findFirst({ where: { id: settlementId, tenantId }, select: COLUMNS })
      if (!found) throw new NotFoundException({ message: 'Settlement not found', code: SETTLEMENT_FAILURE.notFound })
      await this.lock(tx, found.supplierId, found.currency)
      const current = await tx.supplierSettlement.findFirst({ where: { id: settlementId, tenantId }, select: COLUMNS })
      if (!current) throw new NotFoundException({ message: 'Settlement not found', code: SETTLEMENT_FAILURE.notFound })
      if (current.status !== 'PROPOSED') throw conflict('This settlement has already been decided', SETTLEMENT_FAILURE.alreadyDecided)
      if (to === 'APPROVED') {
        if (current.proposedById === userId) throw new ForbiddenException({ message: 'The person who proposed a settlement cannot approve it', code: SETTLEMENT_FAILURE.selfApproval })
        // Re-checked at approval: reversals may have lowered what is owed since the proposal.
        const { owed, committed } = await this.available(tx, tenantId, current.supplierId, current.currency, current.id)
        if (current.amountMinor > owed - committed) throw conflict(`The amount now exceeds what is still owed to this supplier in ${current.currency}`, SETTLEMENT_FAILURE.exceedsOwed)
      }
      const changed = await tx.supplierSettlement.updateMany({ where: { id: current.id, tenantId, status: 'PROPOSED' }, data: { status: to, decidedById: userId, decidedAt: now, decisionReason: reason } })
      if (changed.count !== 1) throw conflict('This settlement has already been decided', SETTLEMENT_FAILURE.alreadyDecided)
      const decided = await tx.supplierSettlement.findFirstOrThrow({ where: { id: current.id, tenantId }, select: COLUMNS })
      await this.audit(tx, tenantId, userId, to === 'APPROVED' ? 'finance.settlement.approved' : 'finance.settlement.rejected', decided, requestContextId)
      return decided
    })
  }

  async list(tenantId: string, query: Record<string, unknown>): Promise<SettlementListView> {
    const status = typeof query.status === 'string' && ['PROPOSED', 'APPROVED', 'REJECTED'].includes(query.status) ? (query.status as SettlementStatus) : undefined
    if (query.status !== undefined && !status) throw bad('status must be PROPOSED, APPROVED or REJECTED')
    const supplierId = typeof query.supplierId === 'string' && query.supplierId.trim() ? query.supplierId.trim() : undefined
    const rows = await this.db.withTenant(tenantId, (tx) => tx.supplierSettlement.findMany({
      where: { tenantId, ...(status ? { status } : {}), ...(supplierId ? { supplierId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: SETTLEMENT_LIST_LIMIT + 1, select: COLUMNS,
    }))
    const shown = rows.slice(0, SETTLEMENT_LIST_LIMIT)
    const ids = [...new Set(shown.map((r) => r.supplierId))]
    const suppliers = ids.length ? await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true } })) : []
    const names = new Map(suppliers.map((s) => [s.id, s.displayName]))
    return { items: shown.map((r) => view(r, names.get(r.supplierId) ?? null)), listLimit: SETTLEMENT_LIST_LIMIT, truncated: rows.length > SETTLEMENT_LIST_LIMIT }
  }
}
