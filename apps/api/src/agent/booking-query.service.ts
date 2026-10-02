import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { BookingStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'

export interface BookingSummaryView {
  id: string; reference: string; status: string; currency: string; totalMinor: string; createdAt: string
  hotelName: string | null; checkIn: string | null; checkOut: string | null; rooms: number | null; leadGuest: string | null
}
export interface SupplierMutationOperationalView {
  bookingId: string
  supplierKey: string
  operation: string
  mutationId: string
  status: string
  supplierReference: string | null
  attemptedAt: string | null
  requestId: string
  failureCategory: string | null
  lastReconciledAt: string | null
}
export interface BookingTimelineEvent { type: 'recorded' | 'cancelled'; at: string }
export interface BookingDetailView extends BookingSummaryView {
  adults: number | null; children: number | null
  cancellable: boolean
  documents: Array<{ type: string; number: string }>
  supplierMutation: SupplierMutationOperationalView | null
  /** Only timestamps stored on the booking or its cancellation row. Confirmation has no separate timestamp. */
  timeline: BookingTimelineEvent[]
}
export interface BookingListPage {
  items: BookingSummaryView[]
  total: number
  limit: number
  offset: number
}

const DEFAULT_LIMIT = 20
const MAX_LIST = 50
const MAX_OFFSET = 10_000
const BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'] as const satisfies readonly BookingStatus[]

function isBookingStatus(value: string): value is BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(value)
}

/** Read-only tenant-scoped booking views for the Agent portal. Amounts are integer minor-unit strings. */
@Injectable()
export class BookingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, options: { limit?: number; offset?: number; status?: string } = {}): Promise<BookingListPage> {
    const limit = Number.isFinite(options.limit) ? Math.min(MAX_LIST, Math.max(1, Math.trunc(options.limit!))) : DEFAULT_LIMIT
    const offset = Number.isFinite(options.offset) ? Math.trunc(options.offset!) : 0
    if (offset < 0 || offset > MAX_OFFSET) throw new BadRequestException('Offset is outside the supported window')
    if (options.status !== undefined && !isBookingStatus(options.status)) throw new BadRequestException('Unknown booking status')
    const where = { tenantId, ...(options.status ? { status: options.status } : {}) }
    return this.prisma.withTenant(tenantId, async tx => {
      const total = await tx.booking.count({ where })
      const bookings = await tx.booking.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset })
      const names = await this.hotelNames(tx, tenantId, bookings)
      return { items: bookings.map(booking => this.summary(booking, names)), total, limit, offset }
    })
  }

  async detail(tenantId: string, bookingId: string, now = new Date()): Promise<BookingDetailView> {
    return this.prisma.withTenant(tenantId, async tx => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, tenantId },
        include: {
          documents: { select: { type: true, number: true }, orderBy: { issuedAt: 'asc' } },
          supplierMutations: { where: { operation: 'PREBOOK' }, orderBy: { createdAt: 'desc' }, take: 1 },
          cancellations: { select: { createdAt: true }, orderBy: { createdAt: 'asc' } },
        },
      })
      if (!booking) throw new NotFoundException('Booking not found')
      const names = await this.hotelNames(tx, tenantId, [booking])
      const snapshot = booking.searchSnapshot as Record<string, any>
      const checkInMs = typeof snapshot.checkIn === 'string' ? Date.parse(`${snapshot.checkIn}T00:00:00.000Z`) : NaN
      const mutation = booking.supplierMutations[0] ?? null
      const review = await tx.auditEvent.findFirst({
        where: {
          tenantId,
          OR: [
            { entityType: 'booking', entityId: booking.id, action: { in: ['booking.reconciliation.manual_review', 'booking.reconciled', 'booking.prebook.expired'] } },
            ...(mutation ? [{ entityType: 'supplier_mutation', entityId: mutation.id, action: { in: ['supplier.mutation.reconciled', 'supplier.mutation.unknown'] } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      const supplierMutation: SupplierMutationOperationalView | null = mutation ? {
        bookingId: booking.id,
        supplierKey: mutation.supplierKey,
        operation: mutation.operation,
        mutationId: mutation.id,
        status: mutation.status,
        supplierReference: mutation.supplierReference,
        attemptedAt: mutation.attemptedAt?.toISOString() ?? null,
        requestId: mutation.requestId,
        failureCategory: mutation.failureCategory,
        lastReconciledAt: review?.createdAt.toISOString() ?? mutation.resolvedAt?.toISOString() ?? null,
      } : null
      const timeline: BookingTimelineEvent[] = [{ type: 'recorded', at: booking.createdAt.toISOString() }]
      for (const cancellation of booking.cancellations) timeline.push({ type: 'cancelled', at: cancellation.createdAt.toISOString() })
      return { ...this.summary(booking, names), adults: Number.isInteger(snapshot.adults) ? snapshot.adults : null, children: Number.isInteger(snapshot.children) ? snapshot.children : null,
        cancellable: booking.status === 'CONFIRMED' && Number.isFinite(checkInMs) && now.getTime() < checkInMs, documents: booking.documents, supplierMutation, timeline }
    })
  }

  private async hotelNames(tx: Prisma.TransactionClient, tenantId: string, bookings: Array<{ hotelId: string }>) {
    const ids = [...new Set(bookings.map(booking => booking.hotelId))]
    const hotels = ids.length ? await tx.hotel.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }) : []
    return new Map(hotels.map(hotel => [hotel.id, hotel.name]))
  }

  private summary(booking: { id: string; reference: string; status: string; currency: string; totalMinor: bigint; createdAt: Date; hotelId: string; searchSnapshot: Prisma.JsonValue }, names: Map<string, string>): BookingSummaryView {
    const s = booking.searchSnapshot as Record<string, any>
    const guest = s.leadGuest as { firstName?: string; lastName?: string } | undefined
    return { id: booking.id, reference: booking.reference, status: booking.status, currency: booking.currency, totalMinor: booking.totalMinor.toString(), createdAt: booking.createdAt.toISOString(),
      hotelName: names.get(booking.hotelId) ?? null, checkIn: typeof s.checkIn === 'string' ? s.checkIn : null, checkOut: typeof s.checkOut === 'string' ? s.checkOut : null,
      rooms: Number.isInteger(s.rooms) ? s.rooms : null, leadGuest: guest?.firstName && guest?.lastName ? `${guest.firstName} ${guest.lastName}` : null }
  }
}
