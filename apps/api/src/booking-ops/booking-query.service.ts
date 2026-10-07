import { BadRequestException, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { BookingAccessView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingOpsDatabase } from './booking-ops-database'
import { buildBookingOrderBy, buildBookingWhere, parseBookingListQuery, type BookingFilter } from './booking-list-query'

const HOTEL_TEXT_CAP = 200
/** Most ids a single bulk or export resolution may return. Beyond it the caller is told it was truncated and must narrow the query. */
export const BOOKING_QUERY_ID_CAP = 5000

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * The ONE booking-query service (ADR 0039, Phase 6A). The Admin list, Saved Views, bulk-action target resolution, async export and reconciliation drill-down
 * all go through it, so they agree on what a query means, who may run it, in what order, and what a page is.
 *
 *   parse    normalize (contracts) + apply the caller's access            -> BookingFilter
 *   select   the Prisma `where` (tenant and agency scope applied here, from the authenticated session) and the deterministic `orderBy`
 *   ids      the matching booking ids in that order, capped, with a truncation flag (the target set for bulk actions and export)
 *
 * Tenant and actor always come from the authenticated server context passed by the caller; nothing in a query can name a tenant.
 */
@Injectable()
export class BookingQueryService {
  constructor(private readonly ops: BookingOpsDatabase, private readonly prisma: PrismaService) {}

  parse(raw: Record<string, unknown>, access: BookingAccessView): BookingFilter { return parseBookingListQuery(raw, access) }

  /** Hotels matching a text in name/city/country (hotel) and/or in city/country only (destination), within this tenant. null = no hotel constraint. */
  async hotelIds(tenantId: string, filter: BookingFilter): Promise<string[] | null> {
    if (!filter.hotelText && !filter.destination) return null
    const sets: string[][] = []
    if (filter.hotelText) sets.push(await this.matchHotels(tenantId, filter.hotelText, true))
    if (filter.destination) sets.push(await this.matchHotels(tenantId, filter.destination, false))
    return sets.reduce((a, b) => a.filter((id) => b.includes(id)))
  }

  private async matchHotels(tenantId: string, text: string, includeName: boolean): Promise<string[]> {
    const contains = { contains: escapeLike(text), mode: 'insensitive' as const }
    const or: Prisma.HotelWhereInput[] = [{ city: contains }, { countryCode: { equals: text, mode: 'insensitive' } }, ...(includeName ? [{ name: contains }] : [])]
    const hotels = await this.prisma.withTenant(tenantId, (tx) => tx.hotel.findMany({ where: { tenantId, OR: or }, select: { id: true }, take: HOTEL_TEXT_CAP + 1 }))
    if (hotels.length > HOTEL_TEXT_CAP) throw new BadRequestException({ message: 'That hotel or destination search matches too many hotels; narrow it', code: 'BOOKING_QUERY_TOO_BROAD' })
    return hotels.map((h) => h.id)
  }

  async select(tenantId: string, access: BookingAccessView, filter: BookingFilter, now: Date): Promise<{ where: Prisma.BookingWhereInput; orderBy: Prisma.BookingOrderByWithRelationInput[] }> {
    const hotelIds = await this.hotelIds(tenantId, filter)
    return { where: buildBookingWhere(filter, { tenantId, access }, hotelIds, now), orderBy: buildBookingOrderBy(filter) }
  }

  /** Matching ids in canonical order, up to `limit` (default and maximum `BOOKING_QUERY_ID_CAP`). `truncated` is true when more matched than were returned. */
  async ids(tenantId: string, access: BookingAccessView, filter: BookingFilter, now: Date, limit = BOOKING_QUERY_ID_CAP): Promise<{ ids: string[]; truncated: boolean }> {
    const take = Math.min(Math.max(limit, 1), BOOKING_QUERY_ID_CAP)
    const { where, orderBy } = await this.select(tenantId, access, filter, now)
    const rows = await this.ops.withTenant(tenantId, (tx) => tx.booking.findMany({ where, orderBy, take: take + 1, select: { id: true } }))
    return { ids: rows.slice(0, take).map((r) => r.id), truncated: rows.length > take }
  }
}
