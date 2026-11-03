import type { Prisma } from '@prisma/client'
import { ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import { AGENCY_CREDIT_LIMIT_EXCEEDED_CODE, AGENCY_CREDIT_UNAVAILABLE_CODE } from '@bedbanks/contracts'
import { lockWalletRow } from '../ledger/wallet-lock'
import { accountAging, agencyPosition, assertNotOverdue, enforceCreditRisk, lockAgencyCredit } from './agency-account'

/**
 * Refuses a new hold the caller's agency cannot pay for (ADR 0028 slice 3): available = balance + credit line - pending holds.
 * Runs inside the hold transaction after the idempotent replay check, serialised per agency with a transaction advisory lock so two
 * concurrent holds cannot both pass. When the agency account exists, the wallet row is locked for the rest of this transaction
 * before the balance is read (ADR 0110), so a debit cannot commit on the same funds. An early refusal only: the prebook
 * financial authorization is the binding check.
 *
 * A user in no agency is not checked here (inventory holds are not bookings); prebook refuses them (owner decision 2026-10-04).
 * If the position cannot be read the hold is refused (fail closed): this is a money control.
 */
export async function assertAgencyCredit(tx: Prisma.TransactionClient, tenantId: string, userId: string, currency: string, amountMinor: bigint): Promise<void> {
  try {
    const member = await tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } })
    if (!member) return
    await lockAgencyCredit(tx, member.agencyId)
    const account = await tx.wallet.findFirst({ where: { tenantId, agencyId: member.agencyId, currency }, select: { id: true } })
    if (account) await lockWalletRow(tx, tenantId, account.id)
    const position = await agencyPosition(tx, tenantId, member.agencyId, currency)
    assertNotOverdue(await accountAging(tx, tenantId, position.accountId)) // ADR 0028 slice 4: 30 days unpaid refuses new holds
    await enforceCreditRisk(tx, { tenantId, userId, agencyId: member.agencyId, currency, amountMinor, scope: 'HOLD' }) // ADR 0095: dynamic risk policy
    if (amountMinor > position.availableMinor) {
      const available = position.availableMinor > 0n ? position.availableMinor : 0n
      throw new ForbiddenException({ message: 'Your agency does not have enough funds or credit for this hold. Send a payment or contact your account manager.', code: AGENCY_CREDIT_LIMIT_EXCEEDED_CODE, details: { currency, availableMinor: available.toString() } })
    }
  } catch (error) {
    if (error instanceof HttpException) throw error
    throw new ServiceUnavailableException({ message: 'The agency funds could not be checked, so the hold was not placed.', code: AGENCY_CREDIT_UNAVAILABLE_CODE })
  }
}
