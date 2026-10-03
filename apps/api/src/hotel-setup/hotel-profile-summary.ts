import type { Prisma } from '@prisma/client'
import type { HotelContacts, HotelRowProfile } from '@bedbanks/contracts'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import { assessCompleteness } from './hotel-setup-rules'

export interface ProfileSummaryHotel { id: string; name: string; propertyType: string; countryCode: string; city: string; address: string | null; latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null; timeZone: string; starRating: number | null }

const dec = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(6).replace(/\.?0+$/, '') || '0')

/**
 * Profile summaries and verified-mapping counts for one page of hotels, in a fixed number of queries. A SAVEPOINT keeps a denied
 * read of the profile tables (42501, ADR 0013) from aborting the caller's transaction; the answer is then `null`, which callers
 * report as "unavailable", never as "no profile".
 */
export async function loadProfileSummaries(tx: Prisma.TransactionClient, tenantId: string, hotels: ProfileSummaryHotel[], activeRooms: Map<string, number>): Promise<{ profiles: Map<string, HotelRowProfile> | null; verifiedMappings: Map<string, number> }> {
  const ids = hotels.map((h) => h.id)
  const grouped = ids.length ? await tx.supplierHotelMapping.groupBy({ by: ['hotelId'], where: { tenantId, hotelId: { in: ids }, status: 'MAPPED' }, _count: { _all: true } }) : []
  const verifiedMappings = new Map(grouped.map((g) => [g.hotelId, g._count._all]))
  if (ids.length === 0) return { profiles: new Map(), verifiedMappings }
  await tx.$executeRawUnsafe('SAVEPOINT hotel_profile_read')
  try {
    const [profiles, identifiers] = await Promise.all([
      tx.hotelProfile.findMany({ where: { tenantId, hotelId: { in: ids } } }),
      tx.hotelExternalIdentifier.findMany({ where: { tenantId, hotelId: { in: ids } }, orderBy: { scheme: 'asc' } }),
    ])
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT hotel_profile_read')
    const actors = [...new Set(profiles.map((p) => p.updatedById))]
    const users = actors.length ? await tx.user.findMany({ where: { id: { in: actors } }, select: { id: true, name: true, email: true } }) : []
    const label = new Map(users.map((u) => [u.id, u.name || u.email]))
    const byHotel = new Map(profiles.map((p) => [p.hotelId, p]))
    const out = new Map<string, HotelRowProfile>()
    for (const h of hotels) {
      const p = byHotel.get(h.id) ?? null
      const c = assessCompleteness({
        name: h.name, propertyType: h.propertyType, countryCode: h.countryCode, city: h.city, address: h.address, latitude: dec(h.latitude), longitude: dec(h.longitude), timeZone: h.timeZone, starRating: h.starRating,
        starVerified: Boolean(p?.starVerifiedAt), shortDescription: p?.shortDescription ?? null, checkInTime: p?.checkInTime ?? null, checkOutTime: p?.checkOutTime ?? null,
        contacts: (p?.contacts && typeof p.contacts === 'object' && !Array.isArray(p.contacts) ? p.contacts : {}) as HotelContacts, activeRooms: activeRooms.get(h.id) ?? 0,
      })
      out.set(h.id, { exists: p !== null, completenessPercent: c.percent, publishable: c.publishable, starVerified: Boolean(p?.starVerifiedAt), area: p?.area ?? null, updatedBy: p ? label.get(p.updatedById) ?? null : null, externalIdentifiers: identifiers.filter((i) => i.hotelId === h.id).map((i) => ({ scheme: i.scheme, value: i.value })) })
    }
    return { profiles: out, verifiedMappings }
  } catch (error) {
    if (!isBookingReadDenied(error)) throw error
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT hotel_profile_read')
    return { profiles: null, verifiedMappings }
  }
}
