import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { BookingFinancialAuthorizationService, type FinancialAuthorizationCommand } from './booking-financial-authorization.service'

const command: FinancialAuthorizationCommand = {
  tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a', walletId: 'wallet-a',
  bookingId: 'booking-a', currency: 'AED', amountMinor: 6000n, idempotencyKey: 'booking-auth-123',
}
const entry = {
  id: 'ledger-a', tenantId: 'tenant-a', walletId: 'wallet-a', type: 'HOLD', amountMinor: -6000n,
  currency: 'AED', reference: 'booking:booking-a', idempotencyKey: 'booking-auth-123',
}

function setup(input: { locked?: boolean; currency?: string; creditLimit?: bigint; balance?: bigint; existing?: any; agencyId?: string } = {}) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    agencyCreditLimit: { findFirst: jest.fn().mockResolvedValue({ currency: 'AED', limitMinor: 10000n }) },
    $queryRaw: jest.fn().mockResolvedValue(input.locked === false ? [] : [{ id: 'wallet-a' }]),
    wallet: { findFirst: jest.fn().mockResolvedValue(input.locked === false ? null : {
      id: 'wallet-a', tenantId: 'tenant-a', agencyId: input.agencyId ?? null, currency: input.currency ?? 'AED', creditLimit: input.creditLimit ?? 10000n,
    }) },
    ledgerEntry: {
      findUnique: jest.fn().mockResolvedValue(input.existing ?? null),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: input.balance ?? 0n } }),
      create: jest.fn().mockResolvedValue(entry),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (tx: any) => Promise<any>) => work(tx)) }
  return { service: new BookingFinancialAuthorizationService(prisma as any), tx, prisma }
}

describe('BookingFinancialAuthorizationService', () => {
  it('locks the wallet before checking durable credit and writes one negative HOLD', async () => {
    const { service, tx } = setup({ creditLimit: 10000n, balance: 1000n })
    await expect(service.authorize(command)).resolves.toEqual(entry)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.ledgerEntry.aggregate).toHaveBeenCalledTimes(1)
    expect(tx.ledgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: 'HOLD', amountMinor: -6000n, currency: 'AED', reference: 'booking:booking-a',
    }) })
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight agency limit change before reading credit or posting a hold', async () => {
    const { service, tx } = setup({ agencyId: 'agency-a' })
    let unlock!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    tx.$executeRaw.mockImplementationOnce(() => {
      entered()
      return new Promise<number>(resolve => { unlock = () => resolve(1) })
    })
    const result = service.authorize(command)
    await waiting
    expect(tx.ledgerEntry.aggregate).not.toHaveBeenCalled()
    expect(tx.agencyCreditLimit.findFirst).not.toHaveBeenCalled()
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
    // A concurrent approved reduction commits before releasing the shared lock.
    tx.agencyCreditLimit.findFirst.mockResolvedValue({ currency: 'AED', limitMinor: 5000n })
    unlock()
    await expect(result).rejects.toBeInstanceOf(ConflictException)
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
  })

  it('rejects insufficient credit without creating a financial effect', async () => {
    const { service, tx } = setup({ creditLimit: 5000n, balance: 0n })
    await expect(service.authorize(command)).rejects.toBeInstanceOf(ConflictException)
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
    expect(tx.auditEvent.create).not.toHaveBeenCalled()
  })

  it('counts prior durable ledger effects when deciding available credit', async () => {
    const sufficient = setup({ creditLimit: 5000n, balance: 2000n })
    await expect(sufficient.service.authorize(command)).resolves.toEqual(entry)
    const consumed = setup({ creditLimit: 10000n, balance: -5000n })
    await expect(consumed.service.authorize(command)).rejects.toBeInstanceOf(ConflictException)
  })

  it('returns an identical authorization retry without double holding credit', async () => {
    const { service, tx } = setup({ existing: entry })
    await expect(service.authorize(command)).resolves.toEqual(entry)
    expect(tx.ledgerEntry.aggregate).not.toHaveBeenCalled()
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
  })

  it('rejects idempotency reuse with different financial intent', async () => {
    const { service } = setup({ existing: { ...entry, amountMinor: -5999n } })
    await expect(service.authorize(command)).rejects.toBeInstanceOf(ConflictException)
  })

  it('fails closed for cross-tenant/missing wallets and currency mismatch', async () => {
    await expect(setup({ locked: false }).service.authorize(command)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(setup({ currency: 'USD' }).service.authorize(command)).rejects.toBeInstanceOf(ConflictException)
  })

  it('rejects zero or negative authorization amounts', async () => {
    const { service } = setup()
    await expect(service.authorize({ ...command, amountMinor: 0n })).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.authorize({ ...command, amountMinor: -1n })).rejects.toBeInstanceOf(BadRequestException)
  })
})
