import { AgencyCreditService, CREDIT_ENTITY_TYPE, CREDIT_LIMIT_APPROVAL_ACTION } from './agency-credit.service'

describe('approved credit change serialization', () => {
  it('waits for the shared lock before reading or creating a previously absent limit', async () => {
    let unlock!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const approval = { entityId: 'agency-a', entityType: CREDIT_ENTITY_TYPE, action: CREDIT_LIMIT_APPROVAL_ACTION,
      beforeState: { currency: null, limitMinor: null }, proposedState: { currency: 'AED', limitMinor: '5000' } }
    const tx = {
      agency: { findFirst: jest.fn().mockResolvedValue({ id: 'agency-a' }) },
      $executeRaw: jest.fn(() => { entered(); return new Promise<void>(resolve => { unlock = resolve }) }),
      agencyCreditLimit: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    }
    const prisma = { withTenant: async (_tenant: string, work: (client: any) => unknown) => work(tx) }
    const approvals = { get: jest.fn().mockResolvedValue(approval), execute: async (_input: unknown, apply: (a: any) => unknown) => ({ approval, result: await apply(approval) }) }
    const service = new AgencyCreditService(prisma as any, { record: jest.fn() } as any, approvals as any, {} as any)
    jest.spyOn(service, 'detail').mockResolvedValue({} as any)
    const result = service.execute('tenant-a', 'user-a', 'approval-a')
    await waiting
    expect(tx.agencyCreditLimit.findFirst).not.toHaveBeenCalled()
    expect(tx.agencyCreditLimit.create).not.toHaveBeenCalled()
    unlock()
    await result
    expect(tx.agencyCreditLimit.create).toHaveBeenCalledWith({ data: {
      tenantId: 'tenant-a', agencyId: 'agency-a', currency: 'AED', limitMinor: 5000n, updatedById: 'user-a',
    } })
  })
})
