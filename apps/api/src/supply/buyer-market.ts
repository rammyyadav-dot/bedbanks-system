import type { PrismaService } from '../database/prisma.service'
import { controlReadFailure } from './commercial-controls'
import { normalizeCountry } from './market-rules'

/**
 * The buying market of an Agent: the country of the agency the user belongs to (a user is in at most one agency per tenant).
 * Null means unknown (no agency, or an agency without a country), and an unknown market never satisfies a contract's sales-market list (ADR 0035).
 * A read that fails is not "unknown": it throws `CommercialControlUnavailableError`, so a contract restricted to a market is never shown or priced on a guess.
 */
export async function loadBuyerMarket(prisma: PrismaService, tenantId: string, userId: string | undefined): Promise<string | null> {
  if (!userId) return null
  try {
    const agency = await prisma.withTenant(tenantId, (tx) => tx.agency.findFirst({ where: { tenantId, members: { some: { tenantId, userId } } }, select: { countryCode: true }, orderBy: { id: 'asc' } }))
    return normalizeCountry(agency?.countryCode)
  } catch (error) {
    throw controlReadFailure('buyer_market', error)
  }
}
