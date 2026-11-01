import type { PrismaService } from '../database/prisma.service'
import { CommercialControlUnavailableError, controlReadFailure } from './commercial-controls'

/** Hotels and suppliers hidden from one user because of the agency they belong to (ADR 0019). */
export interface DistributionRestrictions {
  hotelIds: ReadonlySet<string>
  supplierIds: ReadonlySet<string>
}
export const NO_RESTRICTIONS: DistributionRestrictions = { hotelIds: new Set(), supplierIds: new Set() }

export function isRestricted(restrictions: DistributionRestrictions, target: { hotelId: string; supplierId: string }): boolean {
  return restrictions.hotelIds.has(target.hotelId) || restrictions.supplierIds.has(target.supplierId)
}

/**
 * The ACTIVE restrictions of the agency the user belongs to (a user is in at most one agency per tenant).
 * Valid absence: a user with no agency, or an agency with no ACTIVE restriction, has none.
 * Failure (ADR 0031, superseding ADR 0019 item 9): if the table cannot be read, or a row names no target, this throws
 * `CommercialControlUnavailableError`. A restriction only ever narrows what an agency sees, so "could not read" must never mean "show everything".
 */
export async function loadDistributionRestrictions(prisma: PrismaService, tenantId: string, userId: string | undefined): Promise<DistributionRestrictions> {
  if (!userId) return NO_RESTRICTIONS
  let rows: Array<{ scope: string; hotelId: string | null; supplierId: string | null }>
  try {
    rows = await prisma.withTenant(tenantId, (tx) => tx.distributionRestriction.findMany({
      where: { tenantId, status: 'ACTIVE', agency: { members: { some: { tenantId, userId } } } },
      select: { scope: true, hotelId: true, supplierId: true },
    }))
  } catch (error) {
    throw controlReadFailure('distribution_restrictions', error)
  }
  const hotelIds = new Set<string>()
  const supplierIds = new Set<string>()
  for (const row of rows) {
    if (row.scope === 'HOTEL' && row.hotelId) hotelIds.add(row.hotelId)
    else if (row.scope === 'SUPPLIER' && row.supplierId) supplierIds.add(row.supplierId)
    else throw new CommercialControlUnavailableError('distribution_restrictions', 'malformed')
  }
  return { hotelIds, supplierIds }
}
