import { NO_RESTRICTIONS, isRestricted, loadDistributionRestrictions } from './distribution-restrictions'

describe('distribution restrictions (ADR 0019)', () => {
  const r = { hotelIds: new Set(['h1']), supplierIds: new Set(['s1']) }
  it('hides a restricted hotel or any hotel of a restricted supplier, and nothing else', () => {
    expect(isRestricted(r, { hotelId: 'h1', supplierId: 's9' })).toBe(true)
    expect(isRestricted(r, { hotelId: 'h9', supplierId: 's1' })).toBe(true)
    expect(isRestricted(r, { hotelId: 'h9', supplierId: 's9' })).toBe(false)
    expect(isRestricted(NO_RESTRICTIONS, { hotelId: 'h1', supplierId: 's1' })).toBe(false)
  })
  it('a user with no id (no agency) has no restrictions and the table is not read', async () => {
    const prisma = { withTenant: jest.fn() } as never
    expect(await loadDistributionRestrictions(prisma, 't', undefined)).toBe(NO_RESTRICTIONS)
    expect((prisma as unknown as { withTenant: jest.Mock }).withTenant).not.toHaveBeenCalled()
  })
  it('a denied read applies none and says so; any other failure propagates', async () => {
    const denied = { withTenant: jest.fn().mockRejectedValue(Object.assign(new Error('permission denied for table DistributionRestriction'), { meta: { code: '42501' } })) } as never
    const spy = jest.fn()
    expect(await loadDistributionRestrictions(denied, 't', 'u', spy)).toBe(NO_RESTRICTIONS); expect(spy).toHaveBeenCalledTimes(1)
    const broken = { withTenant: jest.fn().mockRejectedValue(new Error('connection lost')) } as never
    await expect(loadDistributionRestrictions(broken, 't', 'u')).rejects.toThrow('connection lost')
  })
})
