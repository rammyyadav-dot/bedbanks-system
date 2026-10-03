import { ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AGENCY_CREDIT_CURRENCY_MISMATCH_CODE, AGENCY_CREDIT_LIMIT_EXCEEDED_CODE, AGENCY_CREDIT_UNAVAILABLE_CODE } from '@bedbanks/contracts'

/** Hold states that count against an agency's credit: everything that still reserves inventory or became a booking. */
const ACTIVE_STATUSES = ['HOLD_PENDING', 'PROCESSING', 'CONFIRMED'] as const

/**
 * Sum of the sell amounts of holds created by the agency's members, in one currency (ADR 0024). A HELD hold counts only until it
 * expires; a cancelled booking releases its hold, so it stops counting. Integer minor units, no conversion.
 */
export async function agencyCommitted(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string, now = new Date()): Promise<bigint> {
  const members = await tx.agencyMember.findMany({ where: { tenantId, agencyId }, select: { userId: true } })
  if (members.length === 0) return 0n
  const sum = await tx.inventoryHold.aggregate({
    _sum: { sellAmountMinor: true },
    where: {
      tenantId, currency, createdByUserId: { in: members.map((m) => m.userId) },
      OR: [{ status: { in: [...ACTIVE_STATUSES] } }, { status: 'HELD', expiresAt: { gt: now } }],
    },
  })
  return sum._sum.sellAmountMinor ?? 0n
}

/**
 * Refuses a new hold that would take the caller's agency over its limit. Runs inside the hold transaction after the idempotent
 * replay check, and serialises per agency with a transaction advisory lock so two concurrent holds cannot both pass.
 *
 * Policy, stated once: a user in no agency, or an agency with no limit row, is not limited. If the limit cannot be read the hold is
 * refused (fail closed); this is a money control, unlike the suspension guard.
 */
export async function assertAgencyCredit(tx: Prisma.TransactionClient, tenantId: string, userId: string, currency: string, amountMinor: bigint): Promise<void> {
  try {
    const member = await tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } })
    if (!member) return
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agency-credit:${member.agencyId}`}, 0))`)
    const limit = await tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId: member.agencyId } })
    if (!limit) return
    if (limit.currency !== currency) {
      throw new ForbiddenException({ message: 'This agency has a credit limit in a different currency, so this hold cannot be placed.', code: AGENCY_CREDIT_CURRENCY_MISMATCH_CODE })
    }
    const committed = await agencyCommitted(tx, tenantId, member.agencyId, currency)
    if (committed + amountMinor > limit.limitMinor) {
      const available = limit.limitMinor > committed ? limit.limitMinor - committed : 0n
      throw new ForbiddenException({ message: 'This hold would take your agency over its credit limit. Contact your account manager.', code: AGENCY_CREDIT_LIMIT_EXCEEDED_CODE, details: { currency, availableMinor: available.toString() } })
    }
  } catch (error) {
    if (error instanceof HttpException) throw error
    throw new ServiceUnavailableException({ message: 'The agency credit limit could not be checked, so the hold was not placed.', code: AGENCY_CREDIT_UNAVAILABLE_CODE })
  }
}
