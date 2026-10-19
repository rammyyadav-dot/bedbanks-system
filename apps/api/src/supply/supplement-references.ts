import type { Prisma } from '@prisma/client'

/** A supplement may only name an active board of this tenant and a rate plan of this contract (ADR 0067). Returns why not, or null. */
export async function supplementReferenceProblem(tx: Prisma.TransactionClient, tenantId: string, contractId: string, supplements: ReadonlyArray<{ boardBasisId: string | null; ratePlanId: string | null }>): Promise<string | null> {
  const boards = [...new Set(supplements.map((p) => p.boardBasisId).filter((v): v is string => v !== null))]
  const plans = [...new Set(supplements.map((p) => p.ratePlanId).filter((v): v is string => v !== null))]
  if (boards.length && (await tx.boardBasis.count({ where: { id: { in: boards }, tenantId, isActive: true } })) !== boards.length) return 'A board supplement names a board that is not an active board of this tenant.'
  if (plans.length && (await tx.ratePlan.count({ where: { id: { in: plans }, tenantId, contractId } })) !== plans.length) return 'A supplement names a rate plan that is not on this contract.'
  return null
}
