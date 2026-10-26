import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { AgencyCommissionPayout } from '@prisma/client'
import { COMMISSION_PAYOUT_FAILURE, COMMISSION_PAYOUT_STATUSES, type AgencyCommissionPayoutView, type CommissionPayoutStatusName, type Paged } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { appendLedgerEntry } from '../ledger/ledger-core'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enumParam, idParam, pageParams, paged } from '../admin-operations/query-params'
import { calculateCommission } from './commission-tier'
import { parseCommissionPayoutProposal, parseDecisionReason } from './commission-payout-input'

const refuse = (status: 400 | 403 | 404 | 409 | 503, message: string, code: string) => {
  const body = { message, code }
  if (status === 403) return new ForbiddenException(body)
  if (status === 404) return new NotFoundException(body)
  if (status === 409) return new ConflictException(body)
  if (status === 503) return new ServiceUnavailableException(body)
  return new BadRequestException(body)
}
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

type Row = AgencyCommissionPayout

/**
 * Dynamic, tier-based commission payouts to agencies (ADR 0098). Proposing records a closed period's gross booked volume; the
 * server resolves the tier and basis points from `commission-tier.ts` and computes the amount, so neither is ever client
 * supplied. Approving, by a different person, posts exactly one CREDIT to the agency account in the same transaction that
 * marks the payout approved, under the agency wallet row lock. Idempotent on `requestId`; a payout can never be posted twice,
 * because the CREDIT is keyed `agency:<id>:commission-payout:<payoutId>` and the row links its entry (unique).
 * Runs on the API connection like the credit note and cancellation settlement paths, because the booking module's role has no
 * ledger access (ADR 0032). Writes need COMMISSION_PAYOUTS_ENABLED=true.
 */
@Injectable()
export class CommissionPayoutService {
  constructor(private readonly prisma: PrismaService) {}

  private assertEnabled(env: NodeJS.ProcessEnv = process.env) {
    if (env.COMMISSION_PAYOUTS_ENABLED !== 'true') throw refuse(503, 'Commission payouts are not enabled on this deployment.', COMMISSION_PAYOUT_FAILURE.disabled)
  }

  private view(r: Row, me: string): AgencyCommissionPayoutView {
    return {
      id: r.id, number: r.number, agencyId: r.agencyId, periodStart: isoDate(r.periodStart), periodEnd: isoDate(r.periodEnd), currency: r.currency,
      grossBookedMinor: r.grossBookedMinor.toString(), tier: r.tier, commissionBp: r.commissionBp, amountMinor: r.amountMinor.toString(),
      status: r.status as CommissionPayoutStatusName, proposedById: r.proposedById, proposedAt: r.createdAt.toISOString(), decidedById: r.decidedById,
      decidedAt: iso(r.decidedAt), decisionReason: r.decisionReason, ledgerEntryId: r.ledgerEntryId, canDecide: r.status === 'PROPOSED' && r.proposedById !== me,
    }
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<Paged<AgencyCommissionPayoutView>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, COMMISSION_PAYOUT_STATUSES)
    const agencyId = idParam('agencyId', query.agencyId)
    const where: Prisma.AgencyCommissionPayoutWhereInput = { tenantId, ...(status && { status }), ...(agencyId && { agencyId }) }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.agencyCommissionPayout.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.agencyCommissionPayout.count({ where }),
      ])
      return paged(rows.map((r) => this.view(r, me)), page, total)
    })
  }

  /** Locks the agency's wallet in the proposal's currency. Caller is inside a tenant transaction. */
  private async lockAgencyWallet(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string) {
    const agency = await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true, code: true } })
    if (!agency) throw refuse(404, 'Agency not found', COMMISSION_PAYOUT_FAILURE.agencyNotFound)
    const wallet = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "tenant_id" = ${tenantId} AND "agency_id" = ${agencyId} AND "currency" = ${currency} FOR UPDATE`)
    if (wallet.length !== 1) throw refuse(409, `The agency has no ${currency} account to pay the commission into`, COMMISSION_PAYOUT_FAILURE.changed)
    return { agency, walletId: wallet[0].id }
  }

  async propose(tenantId: string, userId: string, body: unknown): Promise<AgencyCommissionPayoutView> {
    this.assertEnabled()
    const p = parseCommissionPayoutProposal(body)
    const replay = async () => {
      const existing = await this.prisma.withTenant(tenantId, (tx) => tx.agencyCommissionPayout.findFirst({ where: { tenantId, requestId: p.requestId } }))
      if (!existing) return null
      if (existing.agencyId !== p.agencyId || isoDate(existing.periodStart) !== p.periodStart || isoDate(existing.periodEnd) !== p.periodEnd || existing.grossBookedMinor.toString() !== p.grossBookedMinor.toString()) {
        throw refuse(409, 'This requestId was already used for a different commission payout', COMMISSION_PAYOUT_FAILURE.requestReused)
      }
      return this.view(existing, userId)
    }
    const earlier = await replay()
    if (earlier) return earlier
    const { tier, commissionBp, amountMinor } = calculateCommission(p.grossBookedMinor)
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const agency = await tx.agency.findFirst({ where: { id: p.agencyId, tenantId }, select: { id: true, code: true } })
        if (!agency) throw refuse(404, 'Agency not found', COMMISSION_PAYOUT_FAILURE.agencyNotFound)
        const overlap = await tx.agencyCommissionPayout.findFirst({ where: { tenantId, agencyId: p.agencyId, periodStart: new Date(p.periodStart), periodEnd: new Date(p.periodEnd) } })
        if (overlap) throw refuse(409, 'A commission payout already exists for this agency and period', COMMISSION_PAYOUT_FAILURE.periodOverlap)
        const last = await tx.agencyCommissionPayout.aggregate({ where: { tenantId, agencyId: p.agencyId }, _max: { seq: true } })
        const seq = (last._max.seq ?? 0) + 1
        const created = await tx.agencyCommissionPayout.create({
          data: {
            tenantId, agencyId: p.agencyId, seq, number: `COM-${agency.code}-P${seq}`, periodStart: new Date(p.periodStart), periodEnd: new Date(p.periodEnd),
            currency: p.currency, grossBookedMinor: p.grossBookedMinor, tier, commissionBp, amountMinor, requestId: p.requestId, proposedById: userId,
          },
        })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.commission_payout.proposed', entityType: 'agency_commission_payout', entityId: created.id, payload: sanitizeAuditPayload({
          agencyId: p.agencyId, number: created.number, periodStart: p.periodStart, periodEnd: p.periodEnd, currency: p.currency, grossBookedMinor: p.grossBookedMinor.toString(), tier, commissionBp, amountMinor: amountMinor.toString(),
        }) } })
        return this.view(created, userId)
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002')) {
        const raced = await replay()
        if (raced) return raced
      }
      throw error
    }
  }

  async approve(tenantId: string, userId: string, payoutId: string): Promise<AgencyCommissionPayoutView> {
    this.assertEnabled()
    const id = idParam('payoutId', payoutId)
    if (!id) throw refuse(400, 'payoutId is required', COMMISSION_PAYOUT_FAILURE.invalid)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const payout = await tx.agencyCommissionPayout.findFirst({ where: { id, tenantId } })
      if (!payout) throw refuse(404, 'Commission payout not found', COMMISSION_PAYOUT_FAILURE.notFound)
      if (payout.status !== 'PROPOSED') throw refuse(409, 'This commission payout is already decided', COMMISSION_PAYOUT_FAILURE.decided)
      if (payout.proposedById === userId) throw refuse(403, 'The person who proposed a commission payout cannot approve it', COMMISSION_PAYOUT_FAILURE.ownProposal)
      const { walletId } = await this.lockAgencyWallet(tx, tenantId, payout.agencyId, payout.currency)
      const reference = `agency:${payout.agencyId}`
      const entry = await appendLedgerEntry(tx, { tenantId, walletId, type: 'CREDIT', amountMinor: payout.amountMinor, currency: payout.currency, reference, idempotencyKey: `agency:${payout.agencyId}:commission-payout:${payout.id}` })
      const moved = await tx.agencyCommissionPayout.updateMany({ where: { id, tenantId, status: 'PROPOSED' }, data: { status: 'APPROVED', decidedById: userId, decidedAt: new Date(), ledgerEntryId: entry.id } })
      if (moved.count !== 1) throw refuse(409, 'This commission payout changed while you were deciding; reload it', COMMISSION_PAYOUT_FAILURE.changed)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.commission_payout.approved', entityType: 'agency_commission_payout', entityId: id, payload: sanitizeAuditPayload({
        agencyId: payout.agencyId, number: payout.number, currency: payout.currency, amountMinor: payout.amountMinor.toString(), walletId, ledgerEntryId: entry.id,
      }) } })
      const after = await tx.agencyCommissionPayout.findFirstOrThrow({ where: { id, tenantId } })
      return this.view(after, userId)
    })
  }

  async reject(tenantId: string, userId: string, payoutId: string, body: unknown): Promise<AgencyCommissionPayoutView> {
    this.assertEnabled()
    const id = idParam('payoutId', payoutId)
    if (!id) throw refuse(400, 'payoutId is required', COMMISSION_PAYOUT_FAILURE.invalid)
    const reason = parseDecisionReason(body)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const payout = await tx.agencyCommissionPayout.findFirst({ where: { id, tenantId } })
      if (!payout) throw refuse(404, 'Commission payout not found', COMMISSION_PAYOUT_FAILURE.notFound)
      if (payout.status !== 'PROPOSED') throw refuse(409, 'This commission payout is already decided', COMMISSION_PAYOUT_FAILURE.decided)
      if (payout.proposedById === userId) throw refuse(403, 'The person who proposed a commission payout cannot reject it; ask another finance user', COMMISSION_PAYOUT_FAILURE.ownProposal)
      const moved = await tx.agencyCommissionPayout.updateMany({ where: { id, tenantId, status: 'PROPOSED' }, data: { status: 'REJECTED', decidedById: userId, decidedAt: new Date(), decisionReason: reason } })
      if (moved.count !== 1) throw refuse(409, 'This commission payout changed while you were deciding; reload it', COMMISSION_PAYOUT_FAILURE.changed)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.commission_payout.rejected', entityType: 'agency_commission_payout', entityId: id, payload: sanitizeAuditPayload({
        agencyId: payout.agencyId, number: payout.number, currency: payout.currency, amountMinor: payout.amountMinor.toString(), reason,
      }) } })
      const after = await tx.agencyCommissionPayout.findFirstOrThrow({ where: { id, tenantId } })
      return this.view(after, userId)
    })
  }
}
