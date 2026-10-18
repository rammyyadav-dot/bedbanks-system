import type { ContractStatus, Prisma, PrismaClient } from '@prisma/client'

/**
 * TEST FIXTURE ONLY. Seeds a contract's lifecycle status (and optionally its terms) straight through the disposable owner connection.
 *
 * The HTTP API no longer lets a generic PATCH set contract `status`, and an ACTIVE contract's terms change only by amendment (ADR 0067):
 * activation needs a second person to approve. Suites that exercise search, pricing or rate plans need an ACTIVE contract as a precondition
 * and are not testing the contract lifecycle, so they seed that state here. The lifecycle itself is proven only through the real routes in
 * `contract-approval.e2e-spec.ts`. Never import this from application code.
 */
export async function setContractStatusFixture(prisma: PrismaClient, contractId: string, status: ContractStatus, terms: Omit<Prisma.ContractUpdateInput, 'status'> = {}): Promise<void> {
  await prisma.contract.update({ where: { id: contractId }, data: { ...terms, status } })
}
