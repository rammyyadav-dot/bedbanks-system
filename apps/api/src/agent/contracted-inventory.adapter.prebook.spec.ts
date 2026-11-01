import { ContractedInventoryAdapter } from './contracted-inventory.adapter'
import { SupplierProviderError } from './supplier.port'

const stored = (expiresAt: string) => ({ offerId: 'offer-a', tenantId: 'tenant-a', expiresAt })
function setup(options: { offer?: ReturnType<typeof stored> | null; hold?: { id: string } | null }) {
  const findFirst = jest.fn().mockResolvedValue(options.hold ?? null)
  const prisma = { withTenant: jest.fn((_t: string, work: (tx: unknown) => unknown) => work({ inventoryHold: { findFirst } })) }
  const adapter = new ContractedInventoryAdapter(prisma as never)
  if (options.offer) (adapter as unknown as { offers: Map<string, unknown> }).offers.set('tenant-a:offer-a', options.offer)
  return { adapter, findFirst }
}
const request = { offerId: 'offer-a', searchId: 'search-a', idempotencyKey: 'booking:b:prebook' }
const context = { tenantId: 'tenant-a', userId: 'user-a', requestId: 'req-a' }

describe('ContractedInventoryAdapter.prebook', () => {
  it('proves the claimed hold for exactly this offer and search, without re-pricing', async () => {
    const { adapter, findFirst } = setup({ offer: stored(new Date(Date.now() + 60_000).toISOString()), hold: { id: 'hold-a' } })
    await expect(adapter.prebook(request, context)).resolves.toEqual({ supplierReference: 'contracted:hold-a' })
    expect(findFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a', offerId: 'offer-a', searchId: 'search-a', status: 'PROCESSING' }, select: { id: true } })
  })

  it('fails closed for an unknown offer, an expired offer or a missing claimed hold', async () => {
    for (const options of [{ offer: null, hold: { id: 'h' } }, { offer: stored(new Date(Date.now() - 1).toISOString()), hold: { id: 'h' } }, { offer: stored(new Date(Date.now() + 60_000).toISOString()), hold: null }]) {
      await expect(setup(options).adapter.prebook(request, context)).rejects.toBeInstanceOf(SupplierProviderError)
    }
  })
})
