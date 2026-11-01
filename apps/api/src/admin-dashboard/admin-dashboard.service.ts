import { ForbiddenException, Injectable } from '@nestjs/common'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { isDatabasePermissionDenied } from '../database/db-errors'
import { PrismaService } from '../database/prisma.service'

export type DashboardRange = '7d' | '30d' | '90d'

/** The API runtime role is not granted booking tables. That is a privilege boundary, not an outage. */
export function isBookingReadDenied(error: unknown): boolean {
  return isDatabasePermissionDenied(error)
}

type ActivityRow = { day: Date; total: number; confirmed: number }
type MoneyRow = { currency: string; amount_minor: string }

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(identity: AuthenticatedUser, range: DashboardRange) {
    // Match AdminRbacGuard's choice. Both authorization and data reads use the
    // same active, server-loaded membership; the query cannot select a tenant.
    const membership = identity.memberships.find((entry) => entry.role === 'owner') ?? identity.memberships[0]
    if (!membership) throw new ForbiddenException('No active tenant membership')

    const days = Number.parseInt(range, 10)
    const now = new Date()
    const start = new Date(now)
    start.setUTCHours(0, 0, 0, 0)
    start.setUTCDate(start.getUTCDate() - days + 1)

    const activeSuppliers = await this.prisma.withTenant(membership.tenantId, (tx) => tx.supplier.count({
      where: { tenantId: membership.tenantId, status: 'ACTIVE' },
    }))

    let bookingMetrics: 'available' | 'unavailable' = 'available'
    let count = 0
    let activity: ActivityRow[] = []
    let recent: Array<{ id: string; reference: string; status: string; currency: string; totalMinor: bigint; searchSnapshot: unknown; hotelId: string | null }> = []
    let totals: MoneyRow[] = []
    try {
      const loaded = await this.prisma.withTenant(membership.tenantId, async (tx) => {
        const [bookingCount, bookingActivity, recentBookings, money] = await Promise.all([
          tx.booking.count({ where: { tenantId: membership.tenantId, createdAt: { gte: start, lte: now } } }),
          tx.$queryRaw<ActivityRow[]>`
            SELECT date_trunc('day', "created_at" AT TIME ZONE 'UTC') AS day,
                   COUNT(*)::integer AS total,
                   COUNT(*) FILTER (WHERE "status" = 'CONFIRMED')::integer AS confirmed
            FROM "Booking"
            WHERE "tenant_id" = ${membership.tenantId}
              AND "created_at" >= ${start} AND "created_at" <= ${now}
            GROUP BY day ORDER BY day
          `,
          tx.booking.findMany({
            where: { tenantId: membership.tenantId, createdAt: { gte: start, lte: now } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 8,
            select: { id: true, reference: true, status: true, currency: true, totalMinor: true, searchSnapshot: true, hotelId: true },
          }),
          tx.$queryRaw<MoneyRow[]>`
            SELECT "currency", SUM("total_minor")::text AS amount_minor
            FROM "Booking"
            WHERE "tenant_id" = ${membership.tenantId}
              AND "created_at" >= ${start} AND "created_at" <= ${now}
              AND "status" = 'CONFIRMED'
            GROUP BY "currency"
          `,
        ])
        return { bookingCount, bookingActivity, recentBookings, money }
      })
      count = loaded.bookingCount
      activity = loaded.bookingActivity
      recent = loaded.recentBookings
      totals = loaded.money
    } catch (error) {
      if (!isBookingReadDenied(error)) throw error
      bookingMetrics = 'unavailable'
    }

    const activityByDay = new Map(activity.map((point) => [point.day.toISOString().slice(0, 10), point]))
    const bookingActivity = bookingMetrics === 'unavailable' ? [] : Array.from({ length: days }, (_, index) => {
      const date = new Date(start)
      date.setUTCDate(start.getUTCDate() + index)
      const key = date.toISOString().slice(0, 10)
      const point = activityByDay.get(key)
      return { date: key, total: point?.total ?? 0, confirmed: point?.confirmed ?? 0 }
    })

    // A single currency may be reported as a gross confirmed booking value.
    // No FX conversion or net revenue source exists. Empty/mixed means unknown.
    const grossBookingValue = totals.length === 1
      ? { amountMinor: totals[0].amount_minor, currency: totals[0].currency }
      : null
    const recentBookings = recent.map((booking) => {
      const snapshot = booking.searchSnapshot && typeof booking.searchSnapshot === 'object' && !Array.isArray(booking.searchSnapshot)
        ? booking.searchSnapshot as Record<string, unknown> : {}
      const field = (key: string) => typeof snapshot[key] === 'string' ? snapshot[key] as string : ''
      return {
        id: booking.id,
        reference: booking.reference,
        agency: field('agency') || 'Unknown agency',
        hotel: field('hotelName') || booking.hotelId,
        checkIn: field('checkIn'),
        checkOut: field('checkOut'),
        status: booking.status.toLowerCase(),
        amount: { amountMinor: booking.totalMinor.toString(), currency: booking.currency },
      }
    })

    return {
      range,
      generatedAt: new Date().toISOString(),
      summary: {
        totalBookings: bookingMetrics === 'unavailable' ? null : count,
        grossBookingValue: bookingMetrics === 'unavailable' ? null : grossBookingValue,
        netRevenue: null,
        activeSuppliers,
        activeHotels: null,
        systemHealth: bookingMetrics === 'unavailable' ? 'degraded' as const : 'healthy' as const,
      },
      bookingActivity,
      revenueOverview: [],
      systemHealth: [
        { name: 'API', state: 'healthy' as const, detail: 'Dashboard request served' },
        {
          name: 'Database',
          state: bookingMetrics === 'unavailable' ? 'degraded' as const : 'healthy' as const,
          detail: bookingMetrics === 'unavailable'
            ? 'Booking metrics are not readable by the API database role'
            : 'Dashboard queries completed',
        },
      ],
      recentBookings,
      alerts: [],
      topDestinations: [],
      topSuppliers: [],
    }
  }
}
