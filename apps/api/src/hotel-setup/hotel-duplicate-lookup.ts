import type { Prisma } from '@prisma/client'
import type { HotelDuplicateCandidate } from '@bedbanks/contracts'
import { findPossibleDuplicates, type DuplicateSubject } from './hotel-duplicates'

export const DUPLICATE_SCAN_CAP = 500
type Tx = Prisma.TransactionClient
const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber())

/**
 * Possible duplicates of one canonical hotel inside its tenant and country (ADR 0057), shared by Hotel Setup and supplier mapping.
 * Scans at most DUPLICATE_SCAN_CAP peers by id, so on a very large tenant the answer is a bounded hint, not a proof.
 */
export async function possibleDuplicatesFor(
  tx: Tx, tenantId: string,
  hotel: { id: string; name: string; city: string; countryCode: string; latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null; contentStatus: string },
  postalCode: string | null,
): Promise<HotelDuplicateCandidate[]> {
  const peers = await tx.hotel.findMany({
    where: { tenantId, countryCode: hotel.countryCode, id: { not: hotel.id } }, orderBy: { id: 'asc' }, take: DUPLICATE_SCAN_CAP,
    select: { id: true, name: true, city: true, countryCode: true, latitude: true, longitude: true, contentStatus: true, profile: { select: { postalCode: true } } },
  })
  const subject: DuplicateSubject = { id: hotel.id, name: hotel.name, city: hotel.city, countryCode: hotel.countryCode, postalCode, latitude: num(hotel.latitude), longitude: num(hotel.longitude), status: hotel.contentStatus }
  return findPossibleDuplicates(subject, peers.map((p) => ({ id: p.id, name: p.name, city: p.city, countryCode: p.countryCode, postalCode: p.profile?.postalCode ?? null, latitude: num(p.latitude), longitude: num(p.longitude), status: p.contentStatus })), 20)
}
