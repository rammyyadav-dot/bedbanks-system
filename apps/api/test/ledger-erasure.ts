import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Test teardown only. The ledger is append-only at the database (ADR 0069): a DELETE is refused unless the transaction set
 * `fbeds.ledger_erasure`, the flag the owner-governed erasure uses. The application never sets it.
 */
export function eraseLedger(prisma: PrismaClient, args: Prisma.LedgerEntryDeleteManyArgs) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('fbeds.ledger_erasure', 'on', true)`
    return tx.ledgerEntry.deleteMany(args)
  })
}
