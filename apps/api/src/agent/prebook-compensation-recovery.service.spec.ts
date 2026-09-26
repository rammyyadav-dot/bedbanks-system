import { PrebookCompensationRecoveryService } from './prebook-compensation-recovery.service'

const command: any = {
  tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a', walletId: 'wallet-a',
  bookingId: 'booking-a', currency: 'AED', amountMinor: 6000n,
  idempotencyKey: 'booking:booking-a:authorize', inventoryHoldId: 'hold-a',
}

function setup() {
  const finance = { release: jest.fn().mockResolvedValue({ id: 'release-a' }) }
  const inventory = { release: jest.fn().mockResolvedValue(undefined) }
  return { service: new PrebookCompensationRecoveryService(finance as any, inventory as any), finance, inventory }
}

describe('PrebookCompensationRecoveryService', () => {
  it('compensates finance and inventory independently', async () => {
    const { service, finance, inventory } = setup()
    await expect(service.compensate(command)).resolves.toEqual({
      status: 'compensated', financeReleased: true, inventoryReleased: true,
    })
    expect(finance.release).toHaveBeenCalledWith(command)
    expect(inventory.release).toHaveBeenCalledWith(
      'tenant-a', 'hold-a', 'request-a:prebook-compensation', { type: 'USER', userId: 'user-a' },
    )
  })

  it('reports reconciliation when finance release fails but still attempts inventory release', async () => {
    const { service, finance, inventory } = setup()
    finance.release.mockRejectedValue(new Error('ledger unavailable'))
    await expect(service.compensate(command)).resolves.toEqual({
      status: 'reconciliation_required', financeReleased: false, inventoryReleased: true,
    })
    expect(inventory.release).toHaveBeenCalledTimes(1)
  })

  it('reports reconciliation when inventory release fails but preserves finance compensation', async () => {
    const { service, finance, inventory } = setup()
    inventory.release.mockRejectedValue(new Error('inventory unavailable'))
    await expect(service.compensate(command)).resolves.toEqual({
      status: 'reconciliation_required', financeReleased: true, inventoryReleased: false,
    })
    expect(finance.release).toHaveBeenCalledTimes(1)
  })

  it('is safe to retry because both underlying release operations are idempotent', async () => {
    const { service, finance, inventory } = setup()
    finance.release.mockRejectedValueOnce(new Error('temporary ledger failure'))
    await expect(service.compensate(command)).resolves.toEqual({
      status: 'reconciliation_required', financeReleased: false, inventoryReleased: true,
    })
    await expect(service.compensate(command)).resolves.toEqual({
      status: 'compensated', financeReleased: true, inventoryReleased: true,
    })
    expect(finance.release).toHaveBeenCalledTimes(2)
    expect(inventory.release).toHaveBeenCalledTimes(2)
  })
})
