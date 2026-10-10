import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

const norm = (value: string | null) => (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** Exact normalized identity/address collisions only: similar names are not proof of a duplicate property. */
export async function assertHotelIdentityAvailable(tx: Prisma.TransactionClient, tenantId: string, hotel: { name: string; city: string; countryCode: string; address: string | null }, excludeId = '') {
  const name = norm(hotel.name), city = norm(hotel.city), country = hotel.countryCode.trim().toUpperCase(), address = norm(hotel.address)
  // Serializes competing creates/edits without adding a second hotel registry or merging existing records.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenantId, name, city, country, address])}, 0))`
  const duplicate = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "Hotel" WHERE tenant_id = ${tenantId} AND id <> ${excludeId}
      AND upper(btrim(country_code)) = ${country}
      AND lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = ${name}
      AND lower(regexp_replace(btrim(city), '[[:space:]]+', ' ', 'g')) = ${city}
      AND lower(regexp_replace(btrim(coalesce(address, '')), '[[:space:]]+', ' ', 'g')) = ${address}
    LIMIT 1`)
  if (duplicate.length) throw new ConflictException({ code: 'HOTEL_IDENTITY_CONFLICT', message: 'A hotel with the same name, country, city and street address already exists in this tenant.', hotelId: duplicate[0].id })
}
