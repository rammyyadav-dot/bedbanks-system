import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { BookingReconciliationService } from '../src/agent/booking-reconciliation.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'

describe('interrupted booking reconciliation (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const reconciliation = new BookingReconciliationService(prisma, finance, holds, audit)
  const suffix = `recon-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nights = [new Date('2099-03-01'), new Date('2099-03-02')]
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string, walletId: string

  const commandFor = (key: string, holdId: string) => ({
    tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, inventoryHoldId: holdId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, ratePlanId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03',
    rooms: 1, adults: 2, children: 0, childAges: [], currency: 'AED', totalMinor: 125099, leadGuest: { firstName: 'Test', lastName: 'Guest' },
  })
  const newHold = (key: string) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-03-01T12:00:00.000Z' })
  const heldNights = () => prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true } })
  const walletNet = async () => (await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
  const backdate = (holdId: string, minutes: number) => prisma.$executeRawUnsafe(`UPDATE "InventoryHold" SET "updated_at" = now() - interval '${minutes} minutes' WHERE id = '${holdId}'`)
  const reconcile = (extra: object = {}) => reconciliation.reconcileStale({ tenantId, userId, requestId: `${suffix}-${Math.random()}`, ...extra })

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'R', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 5 })) })
    walletId = (await prisma.wallet.create({ data: { tenantId, currency: 'AED', creditLimit: 1_000_000n, cachedBalance: 0n } })).id
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId } })
    await prisma.ratePlan.delete({ where: { id: ratePlanId } })
    await prisma.contract.delete({ where: { id: contractId } })
    await prisma.boardBasis.delete({ where: { id: boardId } })
    await prisma.roomType.delete({ where: { id: roomId } })
    await prisma.hotel.delete({ where: { id: hotelId } })
    await prisma.supplier.delete({ where: { id: supplierId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('returns wallet and inventory of a crashed attempt exactly once, fails the booking, and is idempotent', async () => {
    const hold = await newHold(`${suffix}-crash`)
    const booking = await persistence.persistPending(commandFor(`${suffix}-crash`, hold.holdId))
    await holds.beginProcessing(tenantId, hold.holdId, 'claim', userId)
    await finance.authorize({ tenantId, userId, requestId: 'auth', walletId, bookingId: booking.id, currency: 'AED', amountMinor: 125099n, idempotencyKey: `booking:${booking.id}:authorize` })
    // ... the process dies here: supplier never called, nothing compensated.
    expect(await walletNet()).toBe(-125099n)
    expect(await heldNights()).toEqual([{ held: 1 }, { held: 1 }])

    expect((await reconcile()).examined).toBe(0) // not stale yet
    await backdate(hold.holdId, 45)
    const dry = await reconcile({ dryRun: true })
    expect(dry.items).toEqual([{ holdId: hold.holdId, bookingId: booking.id, outcome: 'would_reconcile' }])
    expect(await walletNet()).toBe(-125099n)

    const result = await reconcile()
    expect(result.items).toEqual([{ holdId: hold.holdId, bookingId: booking.id, outcome: 'reconciled' }])
    expect(await walletNet()).toBe(0n)
    expect(await heldNights()).toEqual([{ held: 0 }, { held: 0 }])
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'RELEASED' })
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'FAILED' })
    expect(await prisma.ledgerEntry.count({ where: { walletId, reference: `booking:${booking.id}` } })).toBe(2)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.reconciled', entityId: booking.id, userId } })).toBe(1)

    const again = await reconcile()
    expect(again.examined).toBe(0)
    expect(await walletNet()).toBe(0n)
  })

  it('never releases a booking whose supplier prebook succeeded, and recovers one whose prebook failed', async () => {
    const supplier = (outcome: 'ok' | 'fail') => ({ prebook: async () => { if (outcome === 'fail') throw new Error('down'); return { supplierReference: 'sup-ref-1', rate: {} } } }) as unknown as SupplierAdapter
    const orchestrate = (key: string, holdId: string, outcome: 'ok' | 'fail') =>
      new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, supplier(outcome)).execute({ ...commandFor(key, holdId), walletId } as never)

    const okHold = await newHold(`${suffix}-ok`)
    await expect(orchestrate(`${suffix}-ok`, okHold.holdId, 'ok')).resolves.toMatchObject({ status: 'prebooked' })
    await backdate(okHold.holdId, 45)
    const kept = await reconcile()
    expect(kept.items).toEqual([{ holdId: okHold.holdId, bookingId: expect.any(String), outcome: 'prebooked_awaiting_confirmation' }])
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: okHold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    expect(await walletNet()).toBe(-125099n)

    const failHold = await newHold(`${suffix}-fail`)
    await expect(orchestrate(`${suffix}-fail`, failHold.holdId, 'fail')).rejects.toThrow('Supplier prebook unavailable')
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: failHold.holdId } })).toMatchObject({ status: 'RELEASED' })
    expect(await walletNet()).toBe(-125099n) // only the successful prebook's reservation remains
  })

  it('finishes an attempt whose compensation partly failed, and audits the compensation failure', async () => {
    const hold = await newHold(`${suffix}-partial`)
    const flaky = new PrebookCompensationRecoveryService({ release: async () => { throw new Error('ledger unavailable') } } as never, holds, audit)
    const booking = await persistence.persistPending(commandFor(`${suffix}-partial`, hold.holdId))
    await holds.beginProcessing(tenantId, hold.holdId, 'claim', userId)
    const authorization = { tenantId, userId, requestId: 'auth-p', walletId, bookingId: booking.id, currency: 'AED', amountMinor: 125099n, idempotencyKey: `booking:${booking.id}:authorize` }
    await finance.authorize(authorization)
    const before = await walletNet()
    await expect(flaky.compensate({ ...authorization, inventoryHoldId: hold.holdId })).resolves.toMatchObject({ status: 'reconciliation_required', financeReleased: false, inventoryReleased: true })
    expect(await prisma.auditEvent.count({ where: { tenantId, entityId: booking.id, action: 'booking.compensation.reconciliation_required', userId } })).toBe(1)
    expect(await walletNet()).toBe(before) // wallet reservation still outstanding

    // inventory was already returned (RELEASED), so only a PROCESSING hold is stale; make the stuck state explicit.
    await prisma.inventoryHold.update({ where: { id: hold.holdId }, data: { status: 'PROCESSING' } })
    await prisma.$executeRawUnsafe(`UPDATE "DailyAvailability" SET "held" = "held" + 1 WHERE "rate_plan_id" = '${ratePlanId}'`)
    await backdate(hold.holdId, 60)
    const result = await reconcile()
    expect(result.items.find((item) => item.holdId === hold.holdId)?.outcome).toBe('reconciled')
    expect(await walletNet()).toBe(before + 125099n)
  })

  it('expires a prebooked-but-never-confirmed booking after the window, and confirmation then refuses', async () => {
    const supplier = { prebook: async () => ({ supplierReference: 'sup-exp' }) } as unknown as SupplierAdapter
    const hold = await newHold(`${suffix}-expire`)
    const flow = new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, supplier)
    const pre = await flow.execute({ ...commandFor(`${suffix}-expire`, hold.holdId), walletId } as never)
    const net = await walletNet()
    await backdate(hold.holdId, 45)
    expect((await reconcile()).items.find((item) => item.holdId === hold.holdId)?.outcome).toBe('prebooked_awaiting_confirmation')

    await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "created_at" = now() - interval '2 hours' WHERE "action" = 'booking.prebook.succeeded' AND "entity_id" = '${pre.bookingId}'`)
    expect((await reconcile({ dryRun: true })).items.find((item) => item.holdId === hold.holdId)?.outcome).toBe('would_reconcile')
    const result = await reconcile()
    expect(result.items.find((item) => item.holdId === hold.holdId)).toEqual({ holdId: hold.holdId, bookingId: pre.bookingId, outcome: 'prebook_expired' })
    expect(await walletNet()).toBe(net + 125099n)
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: pre.bookingId } })).toMatchObject({ status: 'FAILED' })
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.prebook.expired', entityId: pre.bookingId } })).toBe(1)
    const confirmation = new BookingConfirmationService(prisma)
    await expect(confirmation.confirm({ tenantId, userId, requestId: 'late', bookingId: pre.bookingId })).rejects.toThrow('not confirmable')
  })

  it('a confirmation racing the expiry has exactly one winner and never refunds a confirmed booking', async () => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment: 20 } })
    const supplier = { prebook: async () => ({ supplierReference: 'sup-race' }) } as unknown as SupplierAdapter
    const confirmation = new BookingConfirmationService(prisma)
    for (let round = 0; round < 5; round++) {
      const key = `${suffix}-race-${round}`
      const hold = await newHold(key)
      const pre = await new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, supplier).execute({ ...commandFor(key, hold.holdId), walletId } as never)
      await backdate(hold.holdId, 45)
      await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "created_at" = now() - interval '2 hours' WHERE "action" = 'booking.prebook.succeeded' AND "entity_id" = '${pre.bookingId}'`)
      const net = await walletNet()
      const [confirmed, swept] = await Promise.allSettled([confirmation.confirm({ tenantId, userId, requestId: `c${round}`, bookingId: pre.bookingId }), reconcile()])
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: pre.bookingId } })
      const types = (await prisma.ledgerEntry.findMany({ where: { walletId, reference: `booking:${pre.bookingId}` }, select: { type: true } })).map((entry) => entry.type).sort()
      expect(swept.status).toBe('fulfilled')
      if (booking.status === 'CONFIRMED') {
        expect(confirmed.status).toBe('fulfilled')
        expect(types).toEqual(['DEBIT', 'HOLD', 'RELEASE']) // settled once, never released as a failure
        expect(await walletNet()).toBe(net)
      } else {
        expect(booking.status).toBe('FAILED')
        expect(confirmed.status).toBe('rejected')
        expect(types).toEqual(['HOLD', 'RELEASE'])
        expect(await walletNet()).toBe(net + 125099n)
      }
    }
  })
})
