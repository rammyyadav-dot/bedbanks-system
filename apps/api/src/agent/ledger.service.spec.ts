import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { LedgerService } from './ledger.service'

describe('LedgerService financial safety', () => {
  const entry = { id: 'le_1', tenantId: 't1', walletId: 'w1', currency: 'AED', amountMinor: -1000n,
    type: 'REFUND' as const, idempotencyKey: 'refund:1', reference: 'booking:1', immutableAt: new Date() }

  const setup = (overrides: Partial<any> = {}) => {
    const tx = {
      wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'w1', tenantId: 't1', currency: 'AED' }) },
      ledgerEntry: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(entry) },
      ...overrides,
    }
    const prisma = { withTenant: jest.fn(async (_tenantId: string, fn: any) => fn(tx)) }
    return { service: new LedgerService(prisma as any), tx }
  }

  const input = { tenantId: 't1', walletId: 'w1', currency: 'AED', amountMinor: -1000n,
    type: 'REFUND' as const, idempotencyKey: 'refund:1', reference: 'booking:1' }

  it('returns an existing entry for a sequential retry with identical financial intent', async () => {
    const { service, tx } = setup()
    tx.ledgerEntry.findUnique.mockResolvedValue(entry)
    await expect(service.post(input)).resolves.toEqual(entry)
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
  })

  it('rejects reuse of an idempotency key with different amount or reference', async () => {
    const { service, tx } = setup()
    tx.ledgerEntry.findUnique.mockResolvedValue(entry)
    await expect(service.post({ ...input, amountMinor: -999n })).rejects.toBeInstanceOf(ConflictException)
    await expect(service.post({ ...input, reference: 'booking:other' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('recovers a concurrent unique-key race by returning the winning identical entry', async () => {
    const { service, tx } = setup()
    tx.ledgerEntry.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(entry)
    tx.ledgerEntry.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.2.1' }))
    await expect(service.post(input)).resolves.toEqual(entry)
    expect(tx.ledgerEntry.findUnique).toHaveBeenCalledTimes(2)
  })

  it('rejects a concurrent winner with different financial intent', async () => {
    const { service, tx } = setup()
    tx.ledgerEntry.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...entry, amountMinor: -500n })
    tx.ledgerEntry.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.2.1' }))
    await expect(service.post(input)).rejects.toBeInstanceOf(ConflictException)
  })

  it('preserves tenant and wallet currency boundaries', async () => {
    const missing = setup({ wallet: { findFirst: jest.fn().mockResolvedValue(null) }, ledgerEntry: { findUnique: jest.fn(), create: jest.fn() } })
    await expect(missing.service.post(input)).rejects.toBeInstanceOf(ForbiddenException)
    const mismatch = setup({ wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'w1', tenantId: 't1', currency: 'USD' }) },
      ledgerEntry: { findUnique: jest.fn(), create: jest.fn() } })
    await expect(mismatch.service.post(input)).rejects.toBeInstanceOf(ConflictException)
  })

  it('rejects zero-value postings and empty idempotency keys', async () => {
    const { service } = setup()
    await expect(service.post({ ...input, amountMinor: 0n })).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.post({ ...input, idempotencyKey: '   ' })).rejects.toBeInstanceOf(BadRequestException)
  })

  it.each([[0n, 0n], [1n, 1n], [999999999999n, 999999999999n]])('allows refund %s within authorized %s', (refundMinor, authorizedRefundableMinor) => {
    const { service } = setup()
    expect(() => service.assertRefundWithinAuthorized({ refundMinor, authorizedRefundableMinor })).not.toThrow()
  })

  it.each([[-1n, 100n], [101n, 100n], [1n, -1n]])('rejects refund %s against authorized %s', (refundMinor, authorizedRefundableMinor) => {
    const { service } = setup()
    expect(() => service.assertRefundWithinAuthorized({ refundMinor, authorizedRefundableMinor })).toThrow(BadRequestException)
  })
})
