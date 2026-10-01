import { BookingReconciliationService, DEFAULT_STALE_MINUTES, MIN_STALE_MINUTES } from './booking-reconciliation.service'

const NOW = new Date('2099-01-01T12:00:00.000Z')

function setup(options: { holds?: string[]; booking?: any; prebooked?: number; reservation?: any } = {}) {
  const tx = {
    inventoryHold: { findMany: jest.fn().mockResolvedValue((options.holds ?? ['hold-a']).map((id) => ({ id }))) },
    booking: { findFirst: jest.fn().mockResolvedValue(options.booking === undefined ? { id: 'booking-a', status: 'PENDING', currency: 'AED', totalMinor: 6000n } : options.booking), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { count: jest.fn().mockResolvedValue(options.prebooked ?? 0) },
    ledgerEntry: { findFirst: jest.fn().mockResolvedValue(options.reservation === undefined ? { walletId: 'wallet-a' } : options.reservation) },
  }
  const prisma = { withTenant: jest.fn((_t: string, work: (t: unknown) => unknown) => work(tx)) }
  const finance = { release: jest.fn().mockResolvedValue({}) }
  const holds = { release: jest.fn().mockResolvedValue(undefined) }
  const audit = { record: jest.fn().mockResolvedValue(undefined) }
  const service = new BookingReconciliationService(prisma as any, finance as any, holds as any, audit as any)
  return { service, tx, finance, holds, audit }
}
const run = (service: BookingReconciliationService, extra: object = {}) => service.reconcileStale({ tenantId: 'tenant-a', userId: 'user-a', requestId: 'req-a', now: NOW, ...extra })

describe('BookingReconciliationService', () => {
  it('releases the wallet reservation and inventory of an interrupted attempt and fails the booking', async () => {
    const { service, finance, holds, tx, audit } = setup()
    const result = await run(service)
    expect(result.items).toEqual([{ holdId: 'hold-a', bookingId: 'booking-a', outcome: 'reconciled' }])
    expect(finance.release).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'wallet-a', bookingId: 'booking-a', amountMinor: 6000n, idempotencyKey: 'booking:booking-a:authorize' }))
    expect(holds.release).toHaveBeenCalledWith('tenant-a', 'hold-a', 'req-a:reconcile', { type: 'USER', userId: 'user-a' })
    expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: 'booking-a', tenantId: 'tenant-a', status: 'PENDING' }, data: { status: 'FAILED' } })
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking.reconciled', userId: 'user-a' }))
  })

  it('uses the stale cutoff and never goes below the minimum age', async () => {
    const { service, tx } = setup()
    await run(service, { staleMinutes: 1 })
    expect(tx.inventoryHold.findMany.mock.calls[0][0].where.updatedAt.lt).toEqual(new Date(NOW.getTime() - MIN_STALE_MINUTES * 60_000))
    await run(service)
    expect(tx.inventoryHold.findMany.mock.calls[1][0].where.updatedAt.lt).toEqual(new Date(NOW.getTime() - DEFAULT_STALE_MINUTES * 60_000))
  })

  it('leaves a successfully prebooked booking alone', async () => {
    const { service, finance, holds } = setup({ prebooked: 1 })
    expect((await run(service)).items[0].outcome).toBe('prebooked_awaiting_confirmation')
    expect(finance.release).not.toHaveBeenCalled(); expect(holds.release).not.toHaveBeenCalled()
  })

  it('leaves a booking that already progressed alone', async () => {
    const { service, holds } = setup({ booking: { id: 'booking-a', status: 'CONFIRMED', currency: 'AED', totalMinor: 6000n } })
    expect((await run(service)).items[0].outcome).toBe('booking_not_pending')
    expect(holds.release).not.toHaveBeenCalled()
  })

  it('skips the wallet when nothing was reserved and still returns the inventory', async () => {
    const { service, finance, holds } = setup({ reservation: null })
    expect((await run(service)).items[0].outcome).toBe('reconciled')
    expect(finance.release).not.toHaveBeenCalled(); expect(holds.release).toHaveBeenCalledTimes(1)
  })

  it('releases an orphaned claimed hold that has no booking', async () => {
    const { service, holds, finance } = setup({ booking: null })
    expect((await run(service)).items[0]).toEqual({ holdId: 'hold-a', bookingId: null, outcome: 'orphan_hold_released' })
    expect(holds.release).toHaveBeenCalledTimes(1); expect(finance.release).not.toHaveBeenCalled()
  })

  it('dry run changes nothing', async () => {
    const { service, finance, holds, tx, audit } = setup()
    const result = await run(service, { dryRun: true })
    expect(result).toMatchObject({ dryRun: true, items: [{ outcome: 'would_reconcile' }] })
    expect(finance.release).not.toHaveBeenCalled(); expect(holds.release).not.toHaveBeenCalled(); expect(tx.booking.updateMany).not.toHaveBeenCalled(); expect(audit.record).not.toHaveBeenCalled()
  })

  it('isolates a failing item, audits it and continues with the rest', async () => {
    const { service, finance, holds, audit } = setup({ holds: ['hold-a', 'hold-b'] })
    finance.release.mockRejectedValueOnce(Object.assign(new Error('ledger down'), { name: 'LedgerDown' }))
    const result = await run(service)
    expect(result.items.map((item) => item.outcome)).toEqual(['failed', 'reconciled'])
    expect(holds.release).toHaveBeenCalledTimes(1)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking.reconciliation.failed', entityId: 'hold-a', payload: { requestId: 'req-a', errorName: 'LedgerDown' } }))
  })
})

import 'reflect-metadata'
import { AgentController } from './agent.controller'
import { REQUIRED_PERMISSION, AgentRbacGuard } from './rbac.guard'
import { TenantContextGuard } from './tenant-context.guard'
import { PERMISSIONS } from './supplier.port'

describe('reconcile-stale endpoint authorization', () => {
  const handler = AgentController.prototype.reconcileStale
  it('is permission-guarded behind tenant validation and RBAC', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION, handler)).toBe(PERMISSIONS.reconcileBookings)
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([TenantContextGuard, AgentRbacGuard])
  })
})
