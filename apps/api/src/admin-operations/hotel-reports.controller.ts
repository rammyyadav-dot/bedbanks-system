import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { BookingAccessView } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccess, BookingAccessGuard } from '../booking-ops/booking-access.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from './supply-permission.guard'
import { HotelReportsService } from './hotel-reports.service'
import { hotelReportCsv } from './hotel-report'
import { PrismaService } from '../database/prisma.service'

@Controller('admin/operations/hotels/:hotelId/reports')
@RequireSupplyPermission('supply.hotels.read')
@UseGuards(SessionAuthGuard, TenantContextGuard, SupplyPermissionGuard, BookingAccessGuard)
export class HotelReportsController {
  constructor(private readonly reports: HotelReportsService, private readonly prisma: PrismaService) {}
  @Get()
  report(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @BookingAccess() access: BookingAccessView, @Query() query: Record<string, unknown>) {
    return this.reports.report(tenantId, hotelId, access, query)
  }
  @Get('export')
  async export(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @BookingAccess() access: BookingAccessView, @Query() query: Record<string, unknown>, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res() res: Response) {
    const report = await this.reports.report(tenantId, hotelId, access, query)
    await this.prisma.withTenant(tenantId, tx => tx.auditEvent.create({ data: { tenantId, userId: identity.user.id, actorType: 'USER', action: 'hotel.report.exported', entityType: 'hotel', entityId: report.hotelId, payload: { query: { ...report.query }, reservations: report.totalReservations, requestId: (req as Request & { requestId?: string }).requestId ?? null } } }))
    res.status(200).set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hotel-report.csv"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(hotelReportCsv(report))
  }
}
