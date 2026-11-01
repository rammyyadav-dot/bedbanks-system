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
  it('a denied or failed read throws instead of applying none; a clean empty read is a valid absence (ADR 0031)', async () => {
    const denied = { withTenant: jest.fn().mockRejectedValue(Object.assign(new Error('permission denied for table DistributionRestriction'), { meta: { code: '42501' } })) } as never
    await expect(loadDistributionRestrictions(denied, 't', 'u')).rejects.toMatchObject({ name: 'CommercialControlUnavailableError', control: 'distribution_restrictions', reason: 'denied', databaseCode: '42501' })
    const broken = { withTenant: jest.fn().mockRejectedValue(new Error('connection lost')) } as never
    await expect(loadDistributionRestrictions(broken, 't', 'u')).rejects.toMatchObject({ reason: 'failed' })
    const empty = { withTenant: jest.fn().mockResolvedValue([]) } as never
    const none = await loadDistributionRestrictions(empty, 't', 'u')
    expect(none.hotelIds.size + none.supplierIds.size).toBe(0)
  })
  it('a row that names no target is malformed and fails closed', async () => {
    const bad = { withTenant: jest.fn().mockResolvedValue([{ scope: 'HOTEL', hotelId: null, supplierId: null }]) } as never
    await expect(loadDistributionRestrictions(bad, 't', 'u')).rejects.toMatchObject({ reason: 'malformed' })
    const good = { withTenant: jest.fn().mockResolvedValue([{ scope: 'HOTEL', hotelId: 'h1', supplierId: null }, { scope: 'SUPPLIER', hotelId: null, supplierId: 's1' }]) } as never
    const r = await loadDistributionRestrictions(good, 't', 'u')
    expect([...r.hotelIds]).toEqual(['h1']); expect([...r.supplierIds]).toEqual(['s1'])
  })
  it('the error carries no message from the database', async () => {
    const denied = { withTenant: jest.fn().mockRejectedValue(new Error('permission denied for table "DistributionRestriction" host=db.internal')) } as never
    const error = await loadDistributionRestrictions(denied, 't', 'u').catch((e: Error) => e)
    expect((error as Error).message).not.toMatch(/DistributionRestriction|db\.internal/)
  })
})
