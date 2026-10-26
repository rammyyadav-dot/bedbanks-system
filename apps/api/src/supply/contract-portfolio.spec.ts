import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { SupplyService } from './supply.service'

function setup(permissions = ['supply.contracts.read']) {
  const tx = {
    userRole: { findMany: jest.fn().mockResolvedValue([{ role: { permissions: permissions.map(key => ({ permission: { key } })) } }]) },
    contract: { findMany: jest.fn().mockResolvedValue([{ id: 'c1' }]), count: jest.fn().mockResolvedValue(51) },
  }
  const prisma = { withTenant: jest.fn(async (_tenant, work) => work(tx)) }
  return { tx, service: new SupplyService(prisma as never, { record: jest.fn().mockResolvedValue(undefined) } as never) }
}

describe('contract portfolio', () => {
  it('filters, sorts and pages in the tenant-scoped database query', async () => {
    const { service, tx } = setup()
    const result = await service.contractPortfolio('tenant', 'user', { page: '3', pageSize: '10', status: 'ACTIVE', search: ' Emaar ', sortBy: 'code', sortDir: 'asc' })
    expect(result).toEqual({ items: [{ id: 'c1' }], page: 3, pageSize: 10, total: 51 })
    expect(tx.contract.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10, orderBy: [{ code: 'asc' }, { id: 'asc' }], where: expect.objectContaining({ tenantId: 'tenant', status: 'ACTIVE' }) }))
    expect(tx.contract.count).toHaveBeenCalledWith({ where: expect.objectContaining({ tenantId: 'tenant' }) })
  })
  it('requires the contracts read permission', async () => {
    const { service } = setup([])
    await expect(service.contractPortfolio('tenant', 'user', {})).rejects.toBeInstanceOf(ForbiddenException)
  })
  it.each([{ page: '0' }, { pageSize: '101' }, { status: 'PUBLISHED' }, { sortBy: 'tenantId' }, { sortDir: 'sideways' }, { search: ['a', 'b'] }])('rejects malformed query %p', async query => {
    const { service } = setup()
    await expect(service.contractPortfolio('tenant', 'user', query)).rejects.toBeInstanceOf(BadRequestException)
  })
})
