import { ConflictException, ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { LedgerService } from '../src/agent/ledger.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'

describe('ledger financial safety on PostgreSQL', () => {
  const prisma = new PrismaService()
  const ledger = new LedgerService(prisma)
  const bookingFinance = new BookingFinancialAuthorizationService(prisma)
  const suffix = `ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let tenantA: string, tenantB: string, walletA: string, walletB: string

  beforeAll(async () => {
    await prisma.$connect()
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix}-a`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } }),
    ])
    tenantA = a.id; tenantB = b.id
    const [wa, wb] = await Promise.all([
      prisma.wallet.create({ data: { tenantId: tenantA, currency: 'AED' } }),
      prisma.wallet.create({ data: { tenantId: tenantB, currency: 'AED' } }),
    ])
    walletA = wa.id; walletB = wb.id
  })

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.wallet.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.$disconnect()
  })

  const post = (key: string, overrides: Partial<Parameters<LedgerService['post']>[0]> = {}) =>
    ledger.post({ tenantId: tenantA, walletId: walletA, currency: 'AED', amountMinor: 10000n,
      type: 'CREDIT', idempotencyKey: key, reference: 'deposit:certification', ...overrides })

  it('converges 25 simultaneous identical credits on one durable financial effect', async () => {
    const attempts = 25
    let arrived = 0
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const results = await Promise.all(Array.from({ length: attempts }, async () => {
      arrived += 1
      if (arrived === attempts) open()
      await gate
      return post(`${suffix}-same`)
    }))
    expect(new Set(results.map(result => result.id)).size).toBe(1)
    const durable = await prisma.ledgerEntry.findMany({ where: { walletId: walletA, idempotencyKey: `${suffix}-same` } })
    expect(durable).toHaveLength(1)
    expect(durable[0]).toMatchObject({ tenantId: tenantA, walletId: walletA, currency: 'AED', amountMinor: 10000n, type: 'CREDIT' })
  })

  it('keeps a sequential retry idempotent', async () => {
    const key = `${suffix}-sequential`
    const first = await post(key)
    const retry = await post(key)
    expect(retry.id).toBe(first.id)
    expect(await prisma.ledgerEntry.count({ where: { walletId: walletA, idempotencyKey: key } })).toBe(1)
  })

  it('fails closed when the same key is reused with different financial intent', async () => {
    const key = `${suffix}-intent`
    await post(key)
    await expect(post(key, { amountMinor: 15000n })).rejects.toBeInstanceOf(ConflictException)
    await expect(post(key, { type: 'DEBIT' })).rejects.toBeInstanceOf(ConflictException)
    await expect(post(key, { reference: 'deposit:different' })).rejects.toBeInstanceOf(ConflictException)
    expect(await prisma.ledgerEntry.count({ where: { walletId: walletA, idempotencyKey: key } })).toBe(1)
  })

  it('fails closed on cross-tenant wallet use and currency mismatch', async () => {
    await expect(post(`${suffix}-foreign`, { walletId: walletB })).rejects.toBeInstanceOf(ForbiddenException)
    await expect(post(`${suffix}-currency`, { currency: 'USD' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('supports one minor unit and large BigInt values without float conversion', async () => {
    const one = await post(`${suffix}-one`, { amountMinor: 1n })
    const large = await post(`${suffix}-large`, { amountMinor: 999999999999n })
    expect(one.amountMinor).toBe(1n)
    expect(large.amountMinor).toBe(999999999999n)
  })


  it('serializes 25 final-credit authorizations without overspending the wallet', async () => {
    await prisma.ledgerEntry.deleteMany({ where: { walletId: walletA } })
    const wallet = await prisma.wallet.update({
      where: { id: walletA },
      data: { creditLimit: 10000n, cachedBalance: 0n },
    })

    try {
      const attempts = 25
      let arrived = 0
      let open!: () => void
      const gate = new Promise<void>(resolve => { open = resolve })
      const settled = await Promise.allSettled(Array.from({ length: attempts }, async (_, index) => {
        arrived += 1
        if (arrived === attempts) open()
        await gate
        return bookingFinance.authorize({
          tenantId: tenantA,
          userId: 'certification-user',
          requestId: `${suffix}-final-credit-${index}`,
          walletId: wallet.id,
          bookingId: `booking-${index}`,
          currency: 'AED',
          amountMinor: 6000n,
          idempotencyKey: `${suffix}-authorization-${index}`,
        })
      }))

      const fulfilled = settled.filter(result => result.status === 'fulfilled')
      const rejected = settled.filter(result => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(24)
      for (const result of rejected) {
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException)
      }

      const holds = await prisma.ledgerEntry.findMany({
        where: { tenantId: tenantA, walletId: wallet.id, type: 'HOLD' },
      })
      expect(holds).toHaveLength(1)
      expect(holds[0].amountMinor).toBe(-6000n)

      const aggregate = await prisma.ledgerEntry.aggregate({
        where: { tenantId: tenantA, walletId: wallet.id },
        _sum: { amountMinor: true },
      })
      expect(aggregate._sum.amountMinor).toBe(-6000n)
      expect((aggregate._sum.amountMinor ?? 0n) + wallet.creditLimit).toBe(4000n)
    } finally {
      await prisma.auditEvent.deleteMany({ where: { tenantId: tenantA, entityType: 'booking', entityId: { startsWith: 'booking-' } } })
      await prisma.ledgerEntry.deleteMany({ where: { walletId: wallet.id } })
      await prisma.wallet.update({ where: { id: wallet.id }, data: { creditLimit: 0n, cachedBalance: 0n } })
    }
  })

  it('enforces refund authorization boundaries without enabling production refunds', () => {
    expect(() => ledger.assertRefundWithinAuthorized({ refundMinor: 0n, authorizedRefundableMinor: 10000n })).not.toThrow()
    expect(() => ledger.assertRefundWithinAuthorized({ refundMinor: 1n, authorizedRefundableMinor: 10000n })).not.toThrow()
    expect(() => ledger.assertRefundWithinAuthorized({ refundMinor: 10000n, authorizedRefundableMinor: 10000n })).not.toThrow()
    expect(() => ledger.assertRefundWithinAuthorized({ refundMinor: 10001n, authorizedRefundableMinor: 10000n })).toThrow()
    expect(() => ledger.assertRefundWithinAuthorized({ refundMinor: -1n, authorizedRefundableMinor: 10000n })).toThrow()
  })
})
