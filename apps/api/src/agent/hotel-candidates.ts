import { Prisma } from '@prisma/client'

export interface HotelCandidateFilter {
  tenantId: string
  /** The resolved city, matched case-insensitively and exactly. */
  city: string
  canonicalHotelIds?: readonly string[]
  propertyTypes?: readonly string[]
}

/**
 * Published hotels of one city (ADR 0074). The generated "city_key" column is lower("city"), compared with a plain "=": the runtime login is under forced
 * row-level security, and PostgreSQL will not use an index for a non-leakproof qual such as lower() or ILIKE there, so `city ILIKE` scanned every hotel of
 * the tenant (28 ms at 60,000 hotels, 0.4 ms through "Hotel_tenant_id_city_key_complete_idx"). The statement keeps its explicit tenant predicate.
 */
export function completeHotelsInCity(f: HotelCandidateFilter): Prisma.Sql {
  const ids = f.canonicalHotelIds?.length ? Prisma.sql`AND "id" = ANY(${[...f.canonicalHotelIds]}::text[])` : Prisma.empty
  const types = f.propertyTypes?.length ? Prisma.sql`AND "property_type" = ANY(${[...f.propertyTypes]}::text[])` : Prisma.empty
  return Prisma.sql`SELECT "id" FROM "Hotel" WHERE "tenant_id" = ${f.tenantId} AND "content_status" = 'COMPLETE' AND "city_key" = lower(${f.city}) ${ids} ${types} ORDER BY "id" ASC`
}
