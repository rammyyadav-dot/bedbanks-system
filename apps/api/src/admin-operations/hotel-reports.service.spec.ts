import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { BookingAccessView } from '@bedbanks/contracts'
import { HotelReportsService, HOTEL_REPORT_LIMIT } from './hotel-reports.service'
import type { PrismaService } from '../database/prisma.service'
import type { BookingOpsDatabase } from '../booking-ops/booking-ops-database'
const access: BookingAccessView = { level: 'OPERATOR', agencyId: null, canViewNet: false, canViewPii: false, permissions: [], manualEntry: false, supplierDispatch: false, opsQueue: false }
const query = { from: '2026-10-10', to: '2026-10-11', dateBasis: 'booking' }
function fixture() {
  const hotel = { findFirst: jest.fn().mockResolvedValue({ id: 'hotel-a' }) }
  const booking = { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) }
  const prisma = { withTenant: jest.fn((_tenant: string, work: (tx: unknown) => unknown) => work({ hotel })) }
  const ops = { withTenant: jest.fn((_tenant: string, work: (tx: unknown) => unknown) => work({ booking })) }
  return { service: new HotelReportsService(prisma as unknown as PrismaService, ops as unknown as BookingOpsDatabase), hotel, booking }
}
describe('hotel report scope and validation', () => {
  it('scopes hotel lookup and all booking queries to authenticated tenant/hotel; omits hidden financial reads', async () => {
    const f = fixture(); await f.service.report('tenant-a', 'hotel-a', access, { ...query, tenantId: 'evil', hotelId: 'evil', supplier: 'DIRECT' })
    expect(f.hotel.findFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a', id: 'hotel-a' }, select: { id: true } })
    expect(f.booking.count.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-a', hotelId: 'hotel-a', supplier: 'DIRECT' })
    expect(f.booking.findMany.mock.calls[0][0].where).toEqual(f.booking.count.mock.calls[0][0].where)
    expect(f.booking.findMany.mock.calls[0][0].select.netMinor).toBe(false); expect(f.booking.findMany.mock.calls[0][0].select.financeEvents).toBeUndefined()
  })
  it('adds agency scope and prevents another hotel from being read', async () => {
    const f = fixture(); await f.service.report('tenant-a', 'hotel-a', { ...access, level: 'AGENCY', agencyId: 'agency-a' }, query)
    expect(f.booking.findMany.mock.calls[0][0].where.agencyId).toBe('agency-a'); f.hotel.findFirst.mockResolvedValue(null)
    await expect(f.service.report('tenant-a', 'hotel-b', access, query)).rejects.toBeInstanceOf(NotFoundException); expect(f.booking.findMany).toHaveBeenCalledTimes(1)
  })
  it('uses stay overlap, rejects impossible/reversed dates and refuses partial totals', async () => {
    const f = fixture(); await f.service.report('tenant-a', 'hotel-a', access, { ...query, dateBasis: 'stay' })
    expect(f.booking.findMany.mock.calls[0][0].where).toMatchObject({ checkIn: { lte: new Date('2026-10-11') }, checkOut: { gt: new Date('2026-10-10') } })
    await expect(f.service.report('tenant-a', 'hotel-a', access, { ...query, from: '2026-02-31' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(f.service.report('tenant-a', 'hotel-a', access, { ...query, to: '2026-10-01' })).rejects.toBeInstanceOf(BadRequestException)
    f.booking.count.mockResolvedValue(HOTEL_REPORT_LIMIT + 1); await expect(f.service.report('tenant-a', 'hotel-a', access, query)).rejects.toThrow('partial totals'); expect(f.booking.findMany).toHaveBeenCalledTimes(1)
  })
})
