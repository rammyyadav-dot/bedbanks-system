import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { LedgerEntryType, PrismaClient } from '@prisma/client'
import { LedgerService } from '../src/agent/ledger.service'
import { PrismaService } from '../src/database/prisma.service'

jest.setTimeout(60_000)

class Barrier {
  private arrived = 0
  private release!: () => void
  private readonly gate = new Promise<void>(resolve => { this.release = resolve })
  constructor(private readonly parties: number) {}
  async wait() {
    this.arrived += 1
    if (this.arrived === this.parties) this.release()
    await this.gate
  }
}

describe('ledger financial safety PostgreSQL E2E', () => {
  const prisma = new PrismaClient()
  const prismaService = new PrismaService()
  const ledger = new LedgerService(prismaService)
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let tenantA: { id: string }
  let tenantB: { id: string }
  let walletA: { id: string }
  let walletB: { id: string }
  let walletUsd: { id: string }

  beforeAll(async () => {
    await prisma.$connect()
    await prismaService.$connect()
    tenantA = await prisma.tenant.create({ data: { name: `ledger-a-${suffix}`, slug: `ledger-a-${suffix}` } })
    tenantB = await prisma.tenant.create({ data: { name: `ledger-b-${suffix}`, slug: `ledger-b-${suffix}` } })
    walletA = await prisma.wallet.create({ data: { tenantId: tenantA.id, currency: 'AED' } })
    walletB = await prisma.wallet.create({ data: { tenantId: tenantB.id, currency: 'AED' } })
    walletUsd = await prisma.wallet.create({ data: { tenantId: tenantA.id, currency: 'USD' } })
  })

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } })
    await prisma.wallet.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } })
    await prismaService.$disconnect()
    await prisma.$disconnect()
  })

  it('converges a 25-way identical-post race to exactly one durable financial effect', async () => {
    const barrier = new Barrier(25)
    const key = `race-25-${suffix}`
    const input = { tenantId: tenantA.id, walletId: walletA.id, currency: 'AED', amountMinor: -12345n,
      type: LedgerEntryType.REFUND, idempotencyKey: key, reference: `booking-race-${suffix}` }
    const results = await Promise.all(Array.from({ length: 25 }, async () => {
      await barrier.wait()
      return ledger.post(input)
    }))
    expect(new Set(results.map(result => result.id))).toHaveLength(1)
    const durable = await prisma.ledgerEntry.findMany({ where: { walletId: walletA.id, idempotencyKey: key } })
    expect(durable).toHaveLength(1)
    expect(durable[0]).toMatchObject(input)
  })

  it('replays an identical retry without another durable effect', async () => {
    const key = `replay-${suffix}`
    const input = { tenantId: tenantA.id, walletId: walletA.id, currency: 'AED', amountMinor: -1000n,
      type: LedgerEntryType.REFUND, idempotencyKey: key, reference: `booking-replay-${suffix}` }
    const first = await ledger.post(input)
    const retries = await Promise.all(Array.from({ length: 10 }, () => ledger.post(input)))
    expect(retries.every(result => result.id === first.id)).toBe(true)
    await expect(prisma.ledgerEntry.count({ where: { walletId: walletA.id, idempotencyKey: key } })).resolves.toBe(1)
  })

  it('rejects reuse of an idempotency key with changed financial intent', async () => {
    const key = `changed-${suffix}`
    const input = { tenantId: tenantA.id, walletId: walletA.id, currency: 'AED', amountMinor: -1000n,
      type: LedgerEntryType.REFUND, idempotencyKey: key, reference: `booking-changed-${suffix}` }
    await ledger.post(input)
    await expect(ledger.post({ ...input, amountMinor: -1001n })).rejects.toBeInstanceOf(ConflictException)
    const durable = await prisma.ledgerEntry.findMany({ where: { walletId: walletA.id, idempotencyKey: key } })
    expect(durable).toHaveLength(1)
    expect(durable[0].amountMinor).toBe(-1000n)
  })

  it('blocks Tenant B from Tenant A wallet', async () => {
    const key = `cross-tenant-${suffix}`
    await expect(ledger.post({ tenantId: tenantB.id, walletId: walletA.id, currency: 'AED', amountMinor: -100n,
      type: LedgerEntryType.REFUND, idempotencyKey: key })).rejects.toBeInstanceOf(ForbiddenException)
    await expect(prisma.ledgerEntry.count({ where: { idempotencyKey: key } })).resolves.toBe(0)
  })

  it('does not deduplicate independent tenant wallets', async () => {
    const key = `tenant-independent-${suffix}`
    const [a, b] = await Promise.all([
      ledger.post({ tenantId: tenantA.id, walletId: walletA.id, currency: 'AED', amountMinor: -100n,
        type: LedgerEntryType.REFUND, idempotencyKey: key }),
      ledger.post({ tenantId: tenantB.id, walletId: walletB.id, currency: 'AED', amountMinor: -100n,
        type: LedgerEntryType.REFUND, idempotencyKey: key }),
    ])
    expect(a.id).not.toBe(b.id)
    await expect(prisma.ledgerEntry.count({ where: { idempotencyKey: key } })).resolves.toBe(2)
  })

  it('rejects wallet currency mismatch without a durable effect', async () => {
    const key = `currency-${suffix}`
    await expect(ledger.post({ tenantId: tenantA.id, walletId: walletUsd.id, currency: 'AED', amountMinor: -100n,
      type: LedgerEntryType.REFUND, idempotencyKey: key })).rejects.toBeInstanceOf(ConflictException)
    await expect(prisma.ledgerEntry.count({ where: { idempotencyKey: key } })).resolves.toBe(0)
  })

  it('rejects zero-value ledger posting without a durable effect', async () => {
    const key = `zero-${suffix}`
    await expect(ledger.post({ tenantId: tenantA.id, walletId: walletA.id, currency: 'AED', amountMinor: 0n,
      type: LedgerEntryType.REFUND, idempotencyKey: key })).rejects.toBeInstanceOf(BadRequestException)
    await expect(prisma.ledgerEntry.count({ where: { idempotencyKey: key } })).resolves.toBe(0)
  })

  it.each([[0n, 0n], [1n, 1n], [9999n, 10000n], [999999999999n, 999999999999n]])(
    'accepts refund %s within authorized %s', (refundMinor, authorizedRefundableMinor) => {
      expect(() => ledger.assertRefundWithinAuthorized({ refundMinor, authorizedRefundableMinor })).not.toThrow()
    })

  it.each([[-1n, 100n], [101n, 100n], [1n, -1n]])(
    'rejects refund %s against authorized %s', (refundMinor, authorizedRefundableMinor) => {
      expect(() => ledger.assertRefundWithinAuthorized({ refundMinor, authorizedRefundableMinor })).toThrow(BadRequestException)
    })
})
