import type { PrismaClient, RatePlanStatus } from '@prisma/client'

/**
 * TEST FIXTURE ONLY. Seeds a rate plan's lifecycle status straight through the disposable owner connection.
 *
 * The HTTP API no longer lets a generic PATCH set `status` (ADR 0041): activation must pass the readiness evaluator through
 * `POST /supply/rate-plans/:id/activate`. Suites that exercise Agent search, pricing or booking need an ACTIVE plan as a
 * precondition and are not testing the lifecycle, so they seed that state here. Lifecycle behaviour itself is proven only
 * through the real routes in `rate-plan-lifecycle.e2e-spec.ts`. Never import this from application code.
 */
export async function setRatePlanStatusFixture(prisma: PrismaClient, ratePlanId: string, status: RatePlanStatus): Promise<void> {
  await prisma.ratePlan.update({ where: { id: ratePlanId }, data: { status } })
}
