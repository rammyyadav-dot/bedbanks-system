import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import type { PrismaService } from '../database/prisma.service'

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
 * The ACTIVE restrictions of the agency the user belongs to (a user is in at most one agency per tenant). A user with no
 * agency has none. If the API database role cannot read the table (ADR 0013), the result is no restrictions and `onUnavailable`
 * lets the caller log it: explicit policy, because blocking every search until a grant is reviewed would be an outage. The
 * Admin Distribution page reports the same denial, so the gap is visible.
 */
export async function loadDistributionRestrictions(prisma: PrismaService, tenantId: string, userId: string | undefined, onUnavailable?: () => void): Promise<DistributionRestrictions> {
  if (!userId) return NO_RESTRICTIONS
  try {
    const rows = await prisma.withTenant(tenantId, (tx) => tx.distributionRestriction.findMany({
      where: { tenantId, status: 'ACTIVE', agency: { members: { some: { tenantId, userId } } } },
      select: { scope: true, hotelId: true, supplierId: true },
    }))
    return {
      hotelIds: new Set(rows.flatMap((r) => (r.scope === 'HOTEL' && r.hotelId ? [r.hotelId] : []))),
      supplierIds: new Set(rows.flatMap((r) => (r.scope === 'SUPPLIER' && r.supplierId ? [r.supplierId] : []))),
    }
  } catch (error) {
    if (isBookingReadDenied(error)) { onUnavailable?.(); return NO_RESTRICTIONS }
    throw error
  }
}
