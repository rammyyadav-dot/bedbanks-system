import { ConflictException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { AgencyCommissionPayout } from '@prisma/client'
import { COMMISSION_PAYOUT_FAILURE } from '@bedbanks/contracts'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { calculateCommission } from './commission-tier'

const refuse404 = () => new NotFoundException({ message: 'Agency not found', code: COMMISSION_PAYOUT_FAILURE.agencyNotFound })
const refuse409 = (message: string) => new ConflictException({ message, code: COMMISSION_PAYOUT_FAILURE.periodOverlap })

/**
 * Who is proposing (ADR 0098 update). A human proposal records the real user as both the row's `proposedById` and the
 * audit actor; an automatic one (the scheduler) records `COMMISSION_SCHEDULER_ACTOR_ID` as `proposedById` and an audit
 * event with `actorType: 'SYSTEM'`, which only the scheduler's own narrow database role may insert (see
 * `commission-payout-scheduler.service.ts` and the `fbeds_commission_scheduler` RLS exception) — the ordinary API role
 * cannot claim to be the system in the audit trail, by the same policy that governs every other sweeper (ADR 0005).
 */
export type CommissionPayoutActor = { kind: 'USER'; userId: string } | { kind: 'SYSTEM' }

/**
 * Creates one PROPOSED commission payout row and its audit event, inside a transaction the caller already holds under
 * the tenant context. Shared by the HTTP service and the scheduler so the tier/amount math, the per-period uniqueness
 * check and the audit payload can never drift between the two call sites. `grossBookedMinor` must already have been
 * derived from posted booking revenue by the caller — this function trusts it completely, so it never accepts a value
 * that originated from an HTTP request body.
 */
export async function createCommissionPayoutRow(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; agencyId: string; periodStart: string; periodEnd: string; currency: string; requestId: string; grossBookedMinor: bigint; actor: CommissionPayoutActor },
): Promise<AgencyCommissionPayout> {
  const { tenantId, agencyId, periodStart, periodEnd, currency, requestId, grossBookedMinor, actor } = params
  const agency = await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true, code: true } })
  if (!agency) throw refuse404()
  const overlap = await tx.agencyCommissionPayout.findFirst({ where: { tenantId, agencyId, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) } })
  if (overlap) throw refuse409('A commission payout already exists for this agency and period')
  const { tier, commissionBp, amountMinor } = calculateCommission(grossBookedMinor)
  const last = await tx.agencyCommissionPayout.aggregate({ where: { tenantId, agencyId }, _max: { seq: true } })
  const seq = (last._max.seq ?? 0) + 1
  const proposedById = actor.kind === 'USER' ? actor.userId : COMMISSION_SCHEDULER_ACTOR_ID
  const created = await tx.agencyCommissionPayout.create({
    data: {
      tenantId, agencyId, seq, number: `COM-${agency.code}-P${seq}`, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
      currency, grossBookedMinor, tier, commissionBp, amountMinor, requestId, proposedById,
    },
  })
  const payload = sanitizeAuditPayload({ agencyId, number: created.number, periodStart, periodEnd, currency, grossBookedMinor: grossBookedMinor.toString(), tier, commissionBp, amountMinor: amountMinor.toString(), source: actor.kind === 'USER' ? 'api' : 'scheduler' })
  if (actor.kind === 'USER') {
    await tx.auditEvent.create({ data: { tenantId, userId: actor.userId, actorType: 'USER', action: 'finance.commission_payout.proposed', entityType: 'agency_commission_payout', entityId: created.id, payload } })
  } else {
    await tx.auditEvent.create({ data: { tenantId, userId: null, actorType: 'SYSTEM', action: 'finance.commission_payout.proposed', entityType: 'agency_commission_payout', entityId: created.id, payload } })
  }
  return created
}

export const COMMISSION_SCHEDULER_ACTOR_ID = 'system:commission-scheduler'
