import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { ExtranetBookingDetail, ExtranetBookingList, ExtranetBookingRoom, ExtranetBookingStatus } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { SupplierExtranetService } from './supplier-extranet.service'
import { decodeCursor, encodeCursor } from './supplier-booking-cursor'
import { summariseNet } from './supplier-booking-net'
import type { ListBookingsQueryDto } from './list-bookings.dto'

const DEFAULT_LIMIT = 25
const PERMISSION = 'supplier.extranet.bookings.read'

// The API runtime role can read ONLY these columns of the booking tables (runtime-role-contract.ts). Every query names its columns.
const bookingSelect = {
  id: true, reference: true, hotelId: true, status: true, currency: true, netMinor: true,
  checkIn: true, checkOut: true, nights: true, supplierRef: true, hotelConfirmationNo: true, createdAt: true,
} as const

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

function parseDay(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`Invalid ${field}`)
  return date
}

/**
 * Read-only bookings owned by the caller's supplier organization (ADR 0061 Amendment 1). Scope is always the authenticated tenant plus the
 * organization resolved by SupplierOrganizationGuard; no identifier from the request widens it. Out-of-scope ids are "not found".
 */
@Injectable()
export class SupplierBookingsService {
  constructor(private readonly prisma: PrismaService, private readonly extranet: SupplierExtranetService) {}

  async list(tenantId: string, userId: string, supplierId: string, query: ListBookingsQueryDto): Promise<ExtranetBookingList> {
    await this.extranet.requirePermission(tenantId, userId, PERMISSION)
    const limit = query.limit ?? DEFAULT_LIMIT
    const from = parseDay(query.checkInFrom, 'checkInFrom')
    const to = parseDay(query.checkInTo, 'checkInTo')
    if (from && to && from > to) throw new BadRequestException('checkInFrom is after checkInTo')
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
    return this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const rows = await tx.booking.findMany({
        where: {
          tenantId,
          supplierId,
          ...(query.status ? { status: query.status } : {}),
          ...(from || to ? { checkIn: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
          ...(query.reference ? { reference: { startsWith: query.reference.toUpperCase() } } : {}),
          ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: bookingSelect,
      })
      const page = rows.slice(0, limit)
      const bookings = await this.shape(tx, tenantId, page)
      const last = page[page.length - 1]
      return {
        bookings: bookings.map(({ rooms: _rooms, hotelConfirmationNo: _hcn, ...summary }) => summary),
        nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      }
    })
  }

  async detail(tenantId: string, userId: string, supplierId: string, bookingId: string): Promise<ExtranetBookingDetail> {
    await this.extranet.requirePermission(tenantId, userId, PERMISSION)
    return this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const row = await tx.booking.findFirst({ where: { id: bookingId, tenantId, supplierId }, select: bookingSelect })
      if (!row) throw new NotFoundException('Booking not found')
      const [detail] = await this.shape(tx, tenantId, [row])
      return detail
    })
  }

  private async shape(tx: Prisma.TransactionClient, tenantId: string, rows: Array<{
    id: string; reference: string; hotelId: string; status: string; currency: string; netMinor: bigint | null; checkIn: Date | null; checkOut: Date | null
    nights: number | null; supplierRef: string | null; hotelConfirmationNo: string | null; createdAt: Date
  }>): Promise<ExtranetBookingDetail[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const [rooms, guests, hotels] = await Promise.all([
      tx.bookingRoom.findMany({
        where: { tenantId, bookingId: { in: ids } },
        orderBy: [{ bookingId: 'asc' }, { position: 'asc' }],
        select: { bookingId: true, position: true, quantity: true, roomName: true, boardCode: true, adults: true, children: true, netMinor: true },
      }),
      tx.bookingGuest.findMany({
        where: { tenantId, bookingId: { in: ids }, isLead: true },
        orderBy: { id: 'asc' },
        select: { bookingId: true, firstName: true, lastName: true },
      }),
      tx.hotel.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((row) => row.hotelId))] } }, select: { id: true, name: true } }),
    ])
    const hotelNames = new Map(hotels.map((hotel) => [hotel.id, hotel.name]))
    const lead = new Map<string, string>()
    for (const guest of guests) if (!lead.has(guest.bookingId)) lead.set(guest.bookingId, `${guest.firstName} ${guest.lastName}`.trim())
    return rows.map((row) => {
      const lines = rooms.filter((room) => room.bookingId === row.id)
      const net = summariseNet(lines.map((line) => line.netMinor), row.netMinor)
      const roomDtos: ExtranetBookingRoom[] = lines.map((line) => ({
        position: line.position, roomName: line.roomName, boardCode: line.boardCode, quantity: line.quantity, adults: line.adults, children: line.children,
        netMinor: line.netMinor === null ? null : line.netMinor.toString(),
      }))
      return {
        id: row.id,
        reference: row.reference,
        status: row.status as ExtranetBookingStatus,
        hotelId: row.hotelId,
        hotelName: hotelNames.get(row.hotelId) ?? null,
        checkIn: day(row.checkIn),
        checkOut: day(row.checkOut),
        nights: row.nights,
        leadGuestName: lead.get(row.id) ?? null,
        currency: row.currency.trim(),
        netMinor: net.netMinor,
        netStatus: net.netStatus,
        supplierRef: row.supplierRef,
        createdAt: row.createdAt.toISOString(),
        hotelConfirmationNo: row.hotelConfirmationNo,
        rooms: roomDtos,
      }
    })
  }
}
