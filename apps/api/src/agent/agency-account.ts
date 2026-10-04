import { ForbiddenException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AGENCY_REQUIRED_FOR_BOOKING_CODE } from '@bedbanks/contracts'

/**
 * One credit concept (ADR 0028 slice 3, owner decision 2026-10-04): an agency's CREDIT LINE is its approved credit limit (ADR 0024
 * maker-checker), in that limit's currency; a credit line in another currency counts as zero, never converted. An agency with no credit
 * line is PREPAID: it can spend its account balance and nothing more. Agency accounts never use `Wallet.credit_limit` (a CHECK keeps it 0).
 *
 *   spendable = account balance (ledger sum) + credit line
 *   pending   = sell amounts of the agency's unexpired holds not yet in the ledger (HOLD_PENDING or HELD; prebook moves a hold to PROCESSING)
 *   available = spendable - pending
 *
 * The binding check is the financial authorization at prebook (wallet row lock, ledger sum). The hold-time check is an early refusal.
 */
const PENDING_STATUSES = ['HOLD_PENDING', 'HELD'] as const

export const accountLockKey = (agencyId: string, currency: string) => `agency-account:${agencyId}:${currency}`

export async function agencyCreditLineMinor(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string): Promise<bigint> {
  const limit = await tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId }, select: { currency: true, limitMinor: true } })
  return limit && limit.currency === currency ? limit.limitMinor : 0n
}

/** The credit line an account may spend against: the agency's for an agency account, the stored limit for the house account. */
export async function accountCreditLineMinor(tx: Prisma.TransactionClient, wallet: { tenantId: string; agencyId: string | null; currency: string; creditLimit: bigint }): Promise<bigint> {
  return wallet.agencyId ? agencyCreditLineMinor(tx, wallet.tenantId, wallet.agencyId, wallet.currency) : wallet.creditLimit
}

export async function agencyPendingMinor(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string, now = new Date()): Promise<bigint> {
  const members = await tx.agencyMember.findMany({ where: { tenantId, agencyId }, select: { userId: true } })
  if (members.length === 0) return 0n
  const sum = await tx.inventoryHold.aggregate({
    _sum: { sellAmountMinor: true },
    where: { tenantId, currency, createdByUserId: { in: members.map(m => m.userId) }, status: { in: [...PENDING_STATUSES] }, expiresAt: { gt: now } },
  })
  return sum._sum.sellAmountMinor ?? 0n
}

export interface AgencyPosition { accountId: string | null; currency: string; balanceMinor: bigint; creditLineMinor: bigint; pendingMinor: bigint; availableMinor: bigint }

export async function agencyPosition(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string): Promise<AgencyPosition> {
  const account = await tx.wallet.findFirst({ where: { tenantId, agencyId, currency }, select: { id: true } })
  const balance = account ? (await tx.ledgerEntry.aggregate({ where: { tenantId, walletId: account.id }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n : 0n
  const creditLine = await agencyCreditLineMinor(tx, tenantId, agencyId, currency)
  const pending = await agencyPendingMinor(tx, tenantId, agencyId, currency)
  return { accountId: account?.id ?? null, currency, balanceMinor: balance, creditLineMinor: creditLine, pendingMinor: pending, availableMinor: balance + creditLine - pending }
}

/**
 * The account a booking of this user is charged to: their agency's account in the hold currency, opened if it does not exist yet.
 * Owner decision (2026-10-04): a user who belongs to no agency cannot book; the house account is never charged for a booking.
 */
export async function bookingAccountFor(tx: Prisma.TransactionClient, tenantId: string, userId: string, currency: string): Promise<{ id: string; agencyId: string }> {
  const member = await tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } })
  if (!member) throw new ForbiddenException({ message: 'Your user is not linked to an agency, so it cannot book. Ask your administrator to add you to your agency.', code: AGENCY_REQUIRED_FOR_BOOKING_CODE })
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountLockKey(member.agencyId, currency)}, 0))`)
  const account = await tx.wallet.findFirst({ where: { tenantId, agencyId: member.agencyId, currency }, select: { id: true } })
    ?? await tx.wallet.create({ data: { tenantId, agencyId: member.agencyId, currency }, select: { id: true } })
  return { id: account.id, agencyId: member.agencyId }
}
