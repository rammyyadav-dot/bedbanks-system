import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
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
export interface BookingDetailView extends BookingSummaryView {
  adults: number | null; children: number | null
  cancellable: boolean
  documents: Array<{ type: string; number: string }>
  supplierMutation: SupplierMutationOperationalView | null
}

const MAX_LIST = 100

/** Read-only tenant-scoped booking views for the Agent portal. Amounts are integer minor-unit strings. */
@Injectable()
export class BookingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, limit = 50): Promise<BookingSummaryView[]> {
    const take = Math.min(MAX_LIST, Math.max(1, Math.trunc(limit) || 50))
    return this.prisma.withTenant(tenantId, async tx => {
      const bookings = await tx.booking.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take })
      const names = await this.hotelNames(tx, tenantId, bookings)
      return bookings.map(booking => this.summary(booking, names))
    })
  }

  async detail(tenantId: string, bookingId: string, now = new Date()): Promise<BookingDetailView> {
    return this.prisma.withTenant(tenantId, async tx => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, tenantId },
        include: {
          documents: { select: { type: true, number: true }, orderBy: { issuedAt: 'asc' } },
          supplierMutations: { where: { operation: 'PREBOOK' }, orderBy: { createdAt: 'desc' }, take: 1 },
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
      return { ...this.summary(booking, names), adults: Number.isInteger(snapshot.adults) ? snapshot.adults : null, children: Number.isInteger(snapshot.children) ? snapshot.children : null,
        cancellable: booking.status === 'CONFIRMED' && Number.isFinite(checkInMs) && now.getTime() < checkInMs, documents: booking.documents, supplierMutation }
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
