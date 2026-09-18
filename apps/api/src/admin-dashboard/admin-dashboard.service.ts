import { ForbiddenException, Injectable } from '@nestjs/common'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'

export type DashboardRange = '7d' | '30d' | '90d'

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(identity: AuthenticatedUser, range: DashboardRange) {
    const membership = identity.memberships[0]
    if (!membership) throw new ForbiddenException('No active tenant membership')
    const roles = await this.prisma.withTenant(membership.tenantId, (tx) => tx.userRole.findMany({
      where: { userId: identity.user.id, tenantId: membership.tenantId, role: { tenantId: membership.tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }))
    const permissions = new Set(roles.flatMap((item) => item.role.permissions.map((entry) => entry.permission.key)))
    const legacyOwner = membership.role === 'owner'
    if (!legacyOwner && !permissions.has('dashboard.read')) throw new ForbiddenException('Insufficient permission')

    const days = Number(range.slice(0, -1))
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    start.setUTCDate(start.getUTCDate() - days + 1)
    const now = new Date()
    const bookings = await this.prisma.withTenant(membership.tenantId, (tx) => tx.booking.findMany({
      where: { tenantId: membership.tenantId, createdAt: { gte: start, lte: now } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }))
    const currencies = new Set(bookings.map((booking) => booking.currency))
    const currency = currencies.size === 1 ? [...currencies][0] : 'MIXED'
    const money = (value: bigint) => currency === 'MIXED' ? null : { amountMinor: value.toString(), currency }
    const totalMinor = bookings.reduce((sum, booking) => sum + (booking.currency === currency ? booking.totalMinor : 0n), 0n)
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0)
    const byDate = new Map<string, { total: number; confirmed: number }>()
    for (let index = 0; index < days; index += 1) {
      const date = new Date(start); date.setUTCDate(start.getUTCDate() + index)
      byDate.set(date.toISOString().slice(0, 10), { total: 0, confirmed: 0 })
    }
    for (const booking of bookings) {
      const key = booking.createdAt.toISOString().slice(0, 10)
      const point = byDate.get(key)
      if (point) { point.total += 1; if (booking.status === 'CONFIRMED') point.confirmed += 1 }
    }
    const recentBookings = bookings.slice(0, 8).map((booking) => {
      const snapshot = booking.searchSnapshot as { hotelName?: string; agency?: string; checkIn?: string; checkOut?: string }
      return { id: booking.id, reference: booking.reference, agency: snapshot.agency ?? 'Unknown agency', hotel: snapshot.hotelName ?? booking.hotelId, checkIn: snapshot.checkIn ?? '', checkOut: snapshot.checkOut ?? '', status: booking.status.toLowerCase(), amount: money(booking.totalMinor), }
    })
    return {
      range, generatedAt: now.toISOString(), currency,
      summary: { totalBookings: bookings.length, todayBookings: bookings.filter((b) => b.createdAt >= todayStart).length, activeHotels: new Set(bookings.map((b) => b.hotelId)).size, activeSuppliers: new Set(bookings.map((b) => b.supplier)).size, grossBookingValue: money(totalMinor), netRevenue: money(totalMinor), pendingActions: bookings.filter((b) => b.status === 'PENDING' || b.status === 'FAILED').length, systemHealth: 'unknown' as const },
      bookingActivity: [...byDate].map(([date, point]) => ({ date, ...point })), revenueOverview: [...byDate].map(([date]) => ({ date, gross: null, net: null })),
      systemHealth: [{ name: 'Database', state: 'healthy' as const }, { name: 'Supplier connections', state: 'unknown' as const }], recentBookings, alerts: [], topDestinations: [], topSuppliers: [],
    }
  }
}
