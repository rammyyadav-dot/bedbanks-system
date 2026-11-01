import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { SupplyService } from './supply.service'

function setup(permissions = ['supply.rooms.read']) {
  const tx = {
    userRole: { findMany: jest.fn().mockResolvedValue([{ role: { permissions: permissions.map(key => ({ permission: { key } })) } }]) },
    roomType: { findMany: jest.fn().mockResolvedValue([{ id: 'r1' }]), count: jest.fn().mockResolvedValue(61) },
  }
  const prisma = { withTenant: jest.fn(async (_tenant, work) => work(tx)) }
  return { tx, service: new SupplyService(prisma as never, { record: jest.fn().mockResolvedValue(undefined) } as never) }
}

describe('room type portfolio', () => {
  it('filters, sorts and pages in the tenant-scoped database query', async () => {
    const { service, tx } = setup()
    const result = await service.roomTypePortfolio('tenant', 'user', { page: '2', pageSize: '20', search: 'deluxe', hotelId: 'h1', sortBy: 'maxOccupancy', sortDir: 'desc' })
    expect(result).toEqual({ items: [{ id: 'r1' }], page: 2, pageSize: 20, total: 61 })
    expect(tx.roomType.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20, orderBy: [{ maxOccupancy: 'desc' }, { id: 'asc' }], where: expect.objectContaining({ hotel: { tenantId: 'tenant' }, hotelId: 'h1' }) }))
    expect(tx.roomType.count).toHaveBeenCalledWith({ where: expect.objectContaining({ hotel: { tenantId: 'tenant' } }) })
  })
  it('requires the rooms read permission', async () => {
    const { service } = setup([])
    await expect(service.roomTypePortfolio('tenant', 'user', {})).rejects.toBeInstanceOf(ForbiddenException)
  })
  it.each([{ page: '0' }, { pageSize: '101' }, { sortBy: 'hotelId' }, { sortDir: 'up' }, { search: ['a'] }])('rejects malformed query %p', async query => {
    const { service } = setup()
    await expect(service.roomTypePortfolio('tenant', 'user', query)).rejects.toBeInstanceOf(BadRequestException)
  })
})
