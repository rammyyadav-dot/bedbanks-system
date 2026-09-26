import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import type { PrismaService } from '../database/prisma.service'
import type { AgentAuditService } from './audit.service'
import type { InventoryHoldService } from './inventory-hold.service'
import { OfferHoldService } from './offer-hold.service'
import type { SupplierAdapter, SupplierRecheckResult } from './supplier.port'

const user = { user: { id: 'user-a' } } as AuthenticatedUser
const authority = {
  offerId: 'offer-a', searchId: 'search-a', supplierId: 'supplier-a', supplierHotelId: 'supplier-hotel-a',
  supplierRoomId: 'supplier-room-a', canonicalHotelId: 'hotel-a', canonicalRoomTypeId: 'room-a',
  ratePlanId: 'plan-a', boardBasisId: 'board-a', checkIn: '2099-01-01', checkOut: '2099-01-03',
  rooms: 1, adults: 2, children: 0, childAges: [], currency: 'AED', sellAmountMinor: 125099,
  expiresAt: '2099-01-01T12:00:00.000Z',
}
const command = { offerId: 'offer-a', searchId: 'search-a', expectedCurrency: 'AED', expectedSellAmountMinor: 125099,
  idempotencyKey: 'request-123', tenantId: 'tenant-a', user, requestId: 'request-a' }

function setup(result: SupplierRecheckResult | Error, mapped = true) {
  const supplier = { name: 'test-supplier', recheck: jest.fn() } as unknown as SupplierAdapter
  if (result instanceof Error) (supplier.recheck as jest.Mock).mockRejectedValue(result)
  else (supplier.recheck as jest.Mock).mockResolvedValue(result)
  const plan = mapped ? { id: 'plan-a', minStay: 1, maxStay: 30, releaseDays: 0 } : null
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (tx: unknown) => Promise<unknown>) =>
    work({ ratePlan: { findFirst: jest.fn().mockResolvedValue(plan) } })) } as unknown as PrismaService
  const holds = { create: jest.fn().mockResolvedValue({ holdId: 'hold-a', requestId: 'request-a', status: 'held',
    expiresAt: '2099-01-01T00:15:00.000Z', currency: 'AED', sellAmountMinor: 125099 }) } as unknown as InventoryHoldService
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AgentAuditService
  return { service: new OfferHoldService(supplier, prisma, holds, audit), supplier, holds, audit }
}

describe('authoritative supplier recheck and hold boundary', () => {
  it('holds only after authoritative recheck and mapping verification', async () => {
    const fixture = setup({ status: 'available', offer: authority })
    await expect(fixture.service.execute(command)).resolves.toMatchObject({ status: 'held', holdId: 'hold-a' })
    expect(fixture.holds.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', offerId: 'offer-a', sellAmountMinor: 125099 }))
  })

  it('returns price_changed without creating a hold', async () => {
    const fixture = setup({ status: 'available', offer: { ...authority, sellAmountMinor: 125100 } })
    await expect(fixture.service.execute(command)).resolves.toMatchObject({ status: 'price_changed', sellAmountMinor: 125100 })
    expect(fixture.holds.create).not.toHaveBeenCalled()
  })

  it('fails closed for invalid mappings and malformed authority', async () => {
    const unmapped = setup({ status: 'available', offer: authority }, false)
    await expect(unmapped.service.execute(command)).resolves.toMatchObject({ status: 'mapping_invalid' })
    expect(unmapped.holds.create).not.toHaveBeenCalled()
    const malformed = setup({ status: 'available', offer: { ...authority, currency: 'aed' } })
    await expect(malformed.service.execute(command)).resolves.toMatchObject({ status: 'rejected' })
  })

  it('sanitizes supplier errors and creates no hold', async () => {
    const fixture = setup(new Error('credential=secret-value'))
    const response = await fixture.service.execute(command)
    expect(response).toEqual({ offerId: 'offer-a', searchId: 'search-a', requestId: 'request-a', status: 'provider_unavailable' })
    expect(JSON.stringify(response)).not.toContain('secret-value')
    expect(fixture.holds.create).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'offer_expired'] as const)('does not allocate for %s supplier outcomes', async status => {
    const fixture = setup({ status })
    await expect(fixture.service.execute(command)).resolves.toMatchObject({ status })
    expect(fixture.holds.create).not.toHaveBeenCalled()
  })

  it('bounds a supplier that never settles and returns a sanitized outcome', async () => {
    jest.useFakeTimers()
    try {
      const fixture = setup({ status: 'available', offer: authority })
      ;(fixture.supplier.recheck as jest.Mock).mockReturnValue(new Promise(() => undefined))
      const pending = fixture.service.execute(command)
      await jest.advanceTimersByTimeAsync(5_000)
      await expect(pending).resolves.toMatchObject({ status: 'provider_unavailable' })
      expect(fixture.holds.create).not.toHaveBeenCalled()
    } finally { jest.useRealTimers() }
  })
})
