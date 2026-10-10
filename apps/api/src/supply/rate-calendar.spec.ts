import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { SupplyService } from './supply.service'

const at = new Date('2030-01-01T00:00:00.000Z')
const rate = (extra = {}) => ({ ratePlanId: 'plan', stayDate: '2030-01-01', occupancy: 2, amountMinor: '15000', amountBasis: 'SELL', currency: 'AED', expectedUpdatedAt: at.toISOString(), ...extra })
const availability = (extra = {}) => ({ ratePlanId: 'plan', stayDate: '2030-01-01', allotment: 10, expectedUpdatedAt: at.toISOString(), ...extra })
function setup() {
  const tx = {
    userRole: { findMany: jest.fn().mockResolvedValue([{ role: { permissions: ['supply.rates.manage', 'supply.availability.manage', 'supply.rates.read'].map(key => ({ permission: { key } })) } }]) },
    ratePlan: { findMany: jest.fn().mockResolvedValue([{ id: 'plan', occupancy: 2, currency: 'AED', inventoryPoolId: null, contract: { settlementCurrency: 'AED', validFrom: at, validTo: new Date('2030-12-31') } }]), count: jest.fn().mockResolvedValue(51) },
    dailyRate: { findUnique: jest.fn().mockResolvedValue({ id: 'rate', amountMinor: 12000n, amountBasis: 'SELL', currency: 'AED', updatedAt: at }), upsert: jest.fn().mockResolvedValue({ id: 'rate', amountMinor: 15000n }) },
    dailyAvailability: { findUnique: jest.fn().mockResolvedValue({ id: 'availability', allotment: 10, sold: 2, held: 1, stopSell: true, minStay: 3, updatedAt: at }), upsert: jest.fn().mockResolvedValue({ id: 'availability' }) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = { withTenant: jest.fn(async (_tenant, work) => work(tx)) }
  const service = new SupplyService(prisma as never, { record: jest.fn().mockResolvedValue(undefined) } as never)
  return { tx, prisma, service }
}
describe('calendar transaction orchestration', () => {
  it('previews exact changes without mutations', async () => {
    const { service, tx } = setup()
    const result = await service.editCalendar('tenant', 'user', { rates: [rate()], availability: [availability()] }, 'request', true, true)
    expect(result).toMatchObject({ preview: true, atomic: true, affectedCells: 2 })
    expect(result.changes[0]).toMatchObject({ before: { amountMinor: '12000' }, after: { amountMinor: '15000' } })
    expect(tx.dailyRate.upsert).not.toHaveBeenCalled(); expect(tx.dailyAvailability.upsert).not.toHaveBeenCalled(); expect(tx.auditEvent.create).not.toHaveBeenCalled()
  })
  it('validates a later availability failure before writing any rates', async () => {
    const { service, tx } = setup()
    await expect(service.editCalendar('tenant', 'user', { rates: [rate()], availability: [availability({ allotment: 1 })] })).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.dailyRate.upsert).not.toHaveBeenCalled()
  })
  it('rejects stale cells before writes', async () => {
    const { service, tx } = setup()
    await expect(service.editCalendar('tenant', 'user', { rates: [rate({ expectedUpdatedAt: null })] })).rejects.toBeInstanceOf(ConflictException)
    expect(tx.dailyRate.upsert).not.toHaveBeenCalled()
  })
  it('requires explicit versions on the review/apply contract', async () => {
    const { service } = setup()
    await expect(service.editCalendar('tenant', 'user', { rates: [rate({ expectedUpdatedAt: undefined })] }, 'request', true, true)).rejects.toBeInstanceOf(BadRequestException)
  })
  it('checks both permissions before querying commercial rows', async () => {
    const { service, tx } = setup()
    tx.userRole.findMany.mockResolvedValue([{ role: { permissions: [{ permission: { key: 'supply.rates.manage' } }] } }])
    await expect(service.editCalendar('tenant', 'user', { rates: [rate()], availability: [availability()] })).rejects.toBeInstanceOf(ForbiddenException)
    expect(tx.ratePlan.findMany).not.toHaveBeenCalled()
  })
  it('does not reveal or edit another tenant plan', async () => {
    const { service, tx } = setup(); tx.ratePlan.findMany.mockResolvedValue([])
    await expect(service.editCalendar('tenant', 'user', { rates: [rate()] })).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.ratePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant', id: { in: ['plan'] } } }))
  })
  it('preserves stored restrictions and never updates sold or held', async () => {
    const { service, tx, prisma } = setup()
    await service.editCalendar('tenant', 'user', { availability: [availability()] })
    expect(tx.dailyAvailability.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { allotment: 10, stopSell: true, minStay: 3, updatedAt: expect.any(Date) } }))
    expect(prisma.withTenant).toHaveBeenLastCalledWith('tenant', expect.any(Function), { isolationLevel: 'Serializable' })
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(1)
  })
  it('maps serializable conflicts to a retryable client conflict', async () => {
    const { service, tx } = setup(); tx.dailyRate.upsert.mockRejectedValue({ code: 'P2034' })
    await expect(service.editCalendar('tenant', 'user', { rates: [rate()] })).rejects.toBeInstanceOf(ConflictException)
  })
  it('leaves a database permission denial observable', async () => {
    const { service, tx } = setup(); const denied = { code: 'P2010', meta: { code: '42501' } }; tx.dailyRate.upsert.mockRejectedValue(denied)
    await expect(service.editCalendar('tenant', 'user', { rates: [rate()] })).rejects.toBe(denied)
  })
  it('rejects other occupancy and outside-contract rates', async () => {
    const { service } = setup()
    await expect(service.editCalendar('tenant', 'user', { rates: [rate({ occupancy: 3 })] })).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.editCalendar('tenant', 'user', { rates: [rate({ stayDate: '2031-01-01' })] })).rejects.toBeInstanceOf(BadRequestException)
  })
})
describe('portfolio paging', () => {
  it('bounds and sorts the database query with a tenant-scoped total', async () => {
    const { service, tx } = setup()
    const result = await service.ratePlanPortfolio('tenant', 'user', { page: '2', pageSize: '25', status: 'DRAFT', search: 'Dubai' })
    expect(result).toMatchObject({ total: 51, page: 2, pageSize: 25, hasMore: true })
    expect(tx.ratePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 25, take: 25, orderBy: [{ code: 'asc' }, { id: 'asc' }], where: expect.objectContaining({ tenantId: 'tenant', status: 'DRAFT' }) }))
  })
  it.each([{ page: '-1' }, { pageSize: '101' }, { page: '1.2' }, { search: ['a', 'b'] }, { status: 'PUBLISHED' }])('rejects malformed filters %p', async query => {
    const { service } = setup()
    await expect(service.ratePlanPortfolio('tenant', 'user', query)).rejects.toBeInstanceOf(BadRequestException)
  })
})
