import type { PrismaClient } from '@prisma/client'

/**
 * ADR 0028 slice 3: a booking is charged to the booker's AGENCY account, and a user in no agency cannot book. Booking suites therefore
 * make their booker a member of an agency with an account and an approved credit line (the agency credit limit). Fixture writes only.
 */
export async function makeAgencyBooker(prisma: PrismaClient, tenantId: string, userId: string, creditLineMinor: bigint, currency = 'AED'): Promise<{ agencyId: string; walletId: string }> {
  const agency = await prisma.agency.create({ data: { tenantId, code: `BK-${userId.slice(-10)}`.toUpperCase(), name: `Booker agency ${userId.slice(-6)}`, createdById: userId } })
  await prisma.agencyMember.create({ data: { tenantId, agencyId: agency.id, userId } })
  await prisma.agencyCreditLimit.create({ data: { tenantId, agencyId: agency.id, currency, limitMinor: creditLineMinor, updatedById: userId } })
  const wallet = await prisma.wallet.create({ data: { tenantId, agencyId: agency.id, currency } })
  return { agencyId: agency.id, walletId: wallet.id }
}

/** Removes what makeAgencyBooker created. Call after the suite has deleted its ledger entries and wallets. */
export async function removeAgencyBookers(prisma: PrismaClient, tenantId: string): Promise<void> {
  await prisma.agencyCreditLimit.deleteMany({ where: { tenantId } })
  await prisma.agencyMember.deleteMany({ where: { tenantId } })
  await prisma.agency.deleteMany({ where: { tenantId } })
}
