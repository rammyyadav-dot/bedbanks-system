import { ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AGENCY_CREDIT_LIMIT_EXCEEDED_CODE, AGENCY_CREDIT_UNAVAILABLE_CODE } from '@bedbanks/contracts'
import { accountAging, agencyPosition, assertNotOverdue } from './agency-account'

/**
 * Refuses a new hold the caller's agency cannot pay for (ADR 0028 slice 3): available = balance + credit line - pending holds.
 * Runs inside the hold transaction after the idempotent replay check, serialised per agency with a transaction advisory lock so two
 * concurrent holds cannot both pass. An early refusal only: the prebook financial authorization is the binding check.
 *
 * A user in no agency is not checked here (inventory holds are not bookings); prebook refuses them (owner decision 2026-10-04).
 * If the position cannot be read the hold is refused (fail closed): this is a money control.
 */
export async function assertAgencyCredit(tx: Prisma.TransactionClient, tenantId: string, userId: string, currency: string, amountMinor: bigint): Promise<void> {
  try {
    const member = await tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } })
    if (!member) return
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agency-credit:${member.agencyId}`}, 0))`)
    const position = await agencyPosition(tx, tenantId, member.agencyId, currency)
    assertNotOverdue(await accountAging(tx, tenantId, position.accountId)) // ADR 0028 slice 4: 30 days unpaid refuses new holds
    if (amountMinor > position.availableMinor) {
      const available = position.availableMinor > 0n ? position.availableMinor : 0n
      throw new ForbiddenException({ message: 'Your agency does not have enough funds or credit for this hold. Send a payment or contact your account manager.', code: AGENCY_CREDIT_LIMIT_EXCEEDED_CODE, details: { currency, availableMinor: available.toString() } })
    }
  } catch (error) {
    if (error instanceof HttpException) throw error
    throw new ServiceUnavailableException({ message: 'The agency funds could not be checked, so the hold was not placed.', code: AGENCY_CREDIT_UNAVAILABLE_CODE })
  }
}
