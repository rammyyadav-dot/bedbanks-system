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

/**
 * The buying agency and its market in one read (ADR 0067, F-11), for client and market markup tiers. Same failure rule as `loadBuyerMarket`: a
 * failed read throws, so a buyer-specific markup is never replaced by a generic one on a guess.
 */
export async function loadBuyerAgency(prisma: PrismaService, tenantId: string, userId: string | undefined): Promise<{ agencyId: string | null; market: string | null }> {
  if (!userId) return { agencyId: null, market: null }
  try {
    const agency = await prisma.withTenant(tenantId, (tx) => tx.agency.findFirst({ where: { tenantId, members: { some: { tenantId, userId } } }, select: { id: true, countryCode: true }, orderBy: { id: 'asc' } }))
    return { agencyId: agency?.id ?? null, market: normalizeCountry(agency?.countryCode) }
  } catch (error) {
    throw controlReadFailure('buyer_market', error)
  }
}
