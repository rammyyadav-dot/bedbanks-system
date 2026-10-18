import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { BookingAccessView, HotelReportQuery, HotelReportView } from '@bedbanks/contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { BookingOpsDatabase } from '../booking-ops/booking-ops-database'
import { dayParam, endOfDay, enumParam, idParam, textParam } from './query-params'
import { buildHotelReport } from './hotel-report'

export const HOTEL_REPORT_LIMIT = 5000
@Injectable()
export class HotelReportsService {
  constructor(private readonly prisma: PrismaService, private readonly ops: BookingOpsDatabase) {}
  async report(tenantId: string, hotelIdRaw: string, access: BookingAccessView, raw: Record<string, unknown>): Promise<HotelReportView> {
    const hotelId = idParam('hotelId', hotelIdRaw)
    const from = dayParam('from', raw.from); const to = dayParam('to', raw.to)
    const dateBasis = enumParam('dateBasis', raw.dateBasis, ['booking', 'stay'] as const) ?? 'booking'
    const supplier = textParam('supplier', raw.supplier, 80)
    if (!hotelId || !from || !to || from > to || to.getTime() - from.getTime() > 366 * 86400000) throw new BadRequestException('Choose a valid hotel and date range of at most 367 inclusive days')
    const hotel = await this.prisma.withTenant(tenantId, tx => tx.hotel.findFirst({ where: { tenantId, id: hotelId }, select: { id: true } }))
    if (!hotel) throw new NotFoundException('Hotel not found')
    if (access.level === 'AGENCY' && !access.agencyId) throw new BadRequestException('Agency scope is required')
    const query: HotelReportQuery = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), dateBasis, ...(supplier ? { supplier } : {}) }
    const where: Prisma.BookingWhereInput = { tenantId, hotelId, ...(access.level === 'AGENCY' ? { agencyId: access.agencyId } : {}), ...(supplier ? { supplier } : {}), ...(dateBasis === 'booking' ? { createdAt: { gte: from, lte: endOfDay(to) } } : { checkIn: { lte: to }, checkOut: { gt: from } }) }
    const finance = access.level === 'OPERATOR' && access.permissions.includes('booking.finance.view')
    const rows = await this.ops.withTenant(tenantId, async tx => {
      if (await tx.booking.count({ where }) > HOTEL_REPORT_LIMIT) throw new BadRequestException(`Narrow the report filters to ${HOTEL_REPORT_LIMIT} reservations or fewer; partial totals are not exported`)
      return tx.booking.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: HOTEL_REPORT_LIMIT, select: {
        status: true, currency: true, totalMinor: true, netMinor: access.canViewNet, checkIn: true, checkOut: true,
        rooms: { where: { tenantId }, select: { quantity: true } }, _count: { select: { guests: { where: { tenantId } } } },
        ...(finance ? { financeEvents: { where: { tenantId, type: 'CANCELLED' }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }], select: { type: true, currency: true, refundMinor: true, penaltyMinor: true } } } : {}),
      } })
    })
    return buildHotelReport(hotelId, query, rows.map(b => ({ ...b, netMinor: access.canViewNet ? b.netMinor : null, financeEvents: finance ? b.financeEvents : [] })), access.canViewNet, finance, new Date())
  }
}
