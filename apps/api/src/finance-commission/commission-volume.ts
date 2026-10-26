import type { Prisma } from '@prisma/client'
import { BookingFinancePostingDatabase } from '../booking-finance-posting/booking-finance-posting.database'

/**
 * Gross booked volume for one agency, currency and closed period (ADR 0098 update): net posted revenue — sales less
 * refunds — on `BookingFinancePosting` rows the Finance consumer has POSTED (ADR 0076), dated by posting date, half-open
 * on `periodEnd` (same convention as `BookingRevenueService`). This is the only source of volume a commission payout may
 * use; nobody, human or scheduler, may supply it directly, so a payout can never be inflated by a client-controlled number.
 * Reads the posting consumer's own narrow role, never the HTTP role's connection, and never silently substitutes zero
 * when that role is unavailable — an unavailable posting role must fail the whole proposal, not understate commission.
 */
export async function commissionGrossBookedVolume(
  tenantServiceTx: Prisma.TransactionClient,
  postings: BookingFinancePostingDatabase,
  tenantId: string,
  agencyId: string,
  currency: string,
  periodStart: string,
  periodEnd: string,
): Promise<bigint> {
  const wallets = await tenantServiceTx.wallet.findMany({ where: { tenantId, agencyId, currency }, select: { id: true } })
  if (wallets.length === 0) return 0n
  const walletIds = wallets.map((w) => w.id)
  const start = new Date(`${periodStart}T00:00:00.000Z`)
  const end = new Date(`${periodEnd}T00:00:00.000Z`)
  const totals = await postings.withTenant(tenantId, (tx) =>
    tx.bookingFinancePosting.aggregate({
      where: { tenantId, status: 'POSTED', walletId: { in: walletIds }, createdAt: { gte: start, lt: end } },
      _sum: { salesMinor: true, refundsMinor: true },
    }),
  )
  const sales = totals._sum.salesMinor ?? 0n
  const refunds = totals._sum.refundsMinor ?? 0n
  const net = sales - refunds
  return net > 0n ? net : 0n
}
