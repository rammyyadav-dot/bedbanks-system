import { ConflictException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

export const RATE_PLAN_FEED_MANAGED = 'RATE_PLAN_FEED_MANAGED'

/**
 * A rate plan with an APPROVED supplier rate plan mapping is feed-managed (ADR 0082): the supplier feed is the single writer of its nightly prices, so no person edits them by hand.
 * The mapping is the flag, so approving it is the one act that hands a plan to a feed and reopening it hands the plan back. A PENDING or REJECTED mapping manages nothing.
 */
export async function feedManagedPlanIds(tx: Prisma.TransactionClient, tenantId: string, ratePlanIds: readonly string[]): Promise<string[]> {
  if (ratePlanIds.length === 0) return []
  const rows = await tx.supplierRatePlanMapping.findMany({ where: { tenantId, ratePlanId: { in: [...new Set(ratePlanIds)] }, status: 'MAPPED' }, select: { ratePlanId: true } })
  return rows.map((r) => r.ratePlanId).sort()
}

/** Refuses a manual price write to a feed-managed plan, naming the plans, before anything is written. */
export async function assertRatesNotFeedManaged(tx: Prisma.TransactionClient, tenantId: string, ratePlanIds: readonly string[]): Promise<void> {
  const managed = await feedManagedPlanIds(tx, tenantId, ratePlanIds)
  if (managed.length > 0) {
    throw new ConflictException({
      code: RATE_PLAN_FEED_MANAGED, ratePlanIds: managed,
      message: 'These rate plans are managed by a supplier feed, which is the only writer of their prices. Reopen the supplier rate plan mapping to edit them by hand. Nothing was written.',
    })
  }
}
