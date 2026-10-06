import { Prisma } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { BookingReconciliationService } from '../src/agent/booking-reconciliation.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingQueryService } from '../src/agent/booking-query.service'
import { SupplierMutationJournalService, supplierMutationFingerprint } from '../src/agent/supplier-mutation-journal.service'
import { SupplierProviderError, type SupplierAdapter } from '../src/agent/supplier.port'

class PrepareFails extends SupplierMutationJournalService {
  override async prepare(): Promise<never> { throw new Error('prepare down') }
}
class SendingFails extends SupplierMutationJournalService {
  override async markSending(): Promise<never> { throw new Error('sending down') }
}
class AckFails extends SupplierMutationJournalService {
  override async acknowledge(): Promise<never> { throw new Error('ack down') }
  override async markUnknown(): Promise<never> { throw new Error('unknown down') }
}

describe('durable supplier mutation journal (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const queries = new BookingQueryService(prisma)
  const journal = new SupplierMutationJournalService(prisma, audit)
  const suffix = `mut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const nights = [new Date('2099-04-01'), new Date('2099-04-02')]
  let tenantId: string, otherTenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string, walletId: string

  const newHold = (key: string) => holds.create({
    tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-04-01', checkOut: '2099-04-03',
    rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-04-01T12:00:00.000Z',
  })
  const commandFor = (key: string, holdId: string) => ({
    tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, inventoryHoldId: holdId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, ratePlanId, boardBasisId: boardId, checkIn: '2099-04-01', checkOut: '2099-04-03',
    rooms: 1, adults: 2, children: 0, childAges: [] as number[], currency: 'AED', totalMinor: 125099,
    leadGuest: { firstName: 'Test', lastName: 'Guest' }, walletId,
  })
  const flow = (mutationJournal: SupplierMutationJournalService, supplier: SupplierAdapter, bookings: BookingPersistenceService = persistence, auditor: AgentAuditService = audit) =>
    new SupplierPrebookOrchestrationService(bookings, finance, recovery, holds, auditor, mutationJournal, supplier)
  const counting = (behavior: 'ok' | 'timeout' | 'reject' = 'ok') => {
    let calls = 0
    const supplier = {
      name: 'contracted-inventory',
      prebook: async () => {
        calls += 1
        if (behavior === 'timeout') throw new SupplierProviderError('timeout')
        if (behavior === 'reject') throw new SupplierProviderError('malformed_response')
        return { supplierReference: `supplier-${suffix}-${calls}` }
      },
    } as unknown as SupplierAdapter
    return { supplier, calls: () => calls }
  }
  const row = (bookingId: string) => prisma.supplierMutation.findFirst({ where: { tenantId, bookingId, operation: 'PREBOOK' } })
  const held = () => prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true, sold: true } })
  const walletNet = async () => (await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
  const backdate = (holdId: string) => prisma.$executeRaw`UPDATE "InventoryHold" SET "updated_at" = NOW() - INTERVAL '90 minutes' WHERE "id" = ${holdId}`
  const reconcile = () => new BookingReconciliationService(prisma, finance, holds, audit).reconcileStale({ tenantId, userId, requestId: `${suffix}-${Math.random()}`, staleMinutes: 5 })

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'R', code: suffix.slice(0, 12), maxAdults: 3, maxChildren: 2, maxOccupancy: 4 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 40 })) })
    walletId = (await prisma.wallet.create({ data: { tenantId, currency: 'AED', creditLimit: 50_000_000n, cachedBalance: 0n } })).id
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.supplierMutation.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.booking.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
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
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })

  it('MUT-01 does not call the supplier when journal prepare fails', async () => {
    const key = `${suffix}-m01`
    const before = await held()
    const hold = await newHold(key)
    const adapter = counting()
    await expect(flow(new PrepareFails(prisma, audit), adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook unavailable')
    expect(adapter.calls()).toBe(0)
    expect(await prisma.supplierMutation.count({ where: { holdId: hold.holdId } })).toBe(0)
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'RELEASED' })
    expect(await held()).toEqual(before)
  })

  it('MUT-02 does not call the supplier when the sending transition fails', async () => {
    const key = `${suffix}-m02`
    const hold = await newHold(key)
    const adapter = counting()
    await expect(flow(new SendingFails(prisma, audit), adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook unavailable')
    expect(adapter.calls()).toBe(0)
    const booking = await prisma.booking.findFirstOrThrow({ where: { tenantId, idempotencyKey: key } })
    expect(await row(booking.id)).toMatchObject({ status: 'PREPARED' })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'RELEASED' })
    const types = (await prisma.ledgerEntry.findMany({ where: { reference: `booking:${booking.id}` }, orderBy: { immutableAt: 'asc' }, select: { type: true } })).map((entry) => entry.type)
    expect(types).toEqual(['HOLD', 'RELEASE'])
  })

  it('MUT-03 keeps a crash after SENDING uncertain and does not compensate', async () => {
    const key = `${suffix}-m03`
    const hold = await newHold(key)
    const booking = await persistence.persistPending(commandFor(key, hold.holdId))
    await holds.beginProcessing(tenantId, hold.holdId, `${key}-req`, userId)
    await finance.authorize({ tenantId, userId, requestId: `${key}-req`, walletId, bookingId: booking.id, currency: 'AED', amountMinor: 125099n, idempotencyKey: `booking:${booking.id}:authorize` })
    const prepared = await journal.prepare({
      tenantId, userId, bookingId: booking.id, holdId: hold.holdId, supplierKey: 'contracted-inventory', operation: 'PREBOOK',
      idempotencyKey: `booking:${booking.id}:prebook`, requestId: `${key}-req`,
      fingerprint: supplierMutationFingerprint({ offerId: `offer-${key}`, searchId: `search-${key}`, holdId: hold.holdId, checkIn: '2099-04-01', checkOut: '2099-04-03', rooms: 1, adults: 2, children: 0, currency: 'AED', totalMinor: 125099 }),
    })
    const claim = await journal.markSending(tenantId, prepared.id, `${key}-req`, userId)
    expect(claim.claimed).toBe(true)
    // Process ends here. A new reconciliation instance must not assume the supplier was not called.
    await backdate(hold.holdId)
    const restarted = await reconcile()
    expect(restarted.items).toEqual([expect.objectContaining({ holdId: hold.holdId, bookingId: booking.id, outcome: 'manual_review_required' })])
    expect(await row(booking.id)).toMatchObject({ status: 'UNKNOWN', failureCategory: 'crash' })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    expect(await prisma.ledgerEntry.count({ where: { idempotencyKey: `booking:${booking.id}:authorize`, type: 'HOLD' } })).toBe(1)
    expect(await prisma.ledgerEntry.count({ where: { idempotencyKey: `booking:${booking.id}:authorize:release` } })).toBe(0)
    const again = await reconcile()
    expect(again.items[0].outcome).toBe('manual_review_required')
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.reconciliation.manual_review', entityId: booking.id } })).toBe(1)
  })

  it('MUT-04 compensates a definitive supplier rejection once', async () => {
    const key = `${suffix}-m04`
    const hold = await newHold(key)
    const before = await walletNet()
    const adapter = counting('reject')
    await expect(flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook unavailable')
    expect(adapter.calls()).toBe(1)
    const booking = await prisma.booking.findFirstOrThrow({ where: { tenantId, idempotencyKey: key } })
    expect(await row(booking.id)).toMatchObject({ status: 'REJECTED', supplierStatus: 'rejected' })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'RELEASED' })
    expect(await walletNet()).toBe(before)
    await expect(flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook unavailable')
    expect(adapter.calls()).toBe(1)
  })

  it('MUT-05 retains inventory and finance on supplier timeout and does not retry', async () => {
    const key = `${suffix}-m05`
    const hold = await newHold(key)
    const beforeHeld = (await held()).map((night) => night.held)
    const adapter = counting('timeout')
    await expect(flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook outcome is unknown')
    expect(adapter.calls()).toBe(1)
    const booking = await prisma.booking.findFirstOrThrow({ where: { tenantId, idempotencyKey: key } })
    expect(await row(booking.id)).toMatchObject({ status: 'UNKNOWN', failureCategory: 'timeout' })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    expect((await held()).map((night) => night.held)).toEqual(beforeHeld)
    expect(await prisma.ledgerEntry.count({ where: { idempotencyKey: `booking:${booking.id}:authorize:release` } })).toBe(0)
    await expect(flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook outcome is unknown')
    expect(adapter.calls()).toBe(1)
  })

  it('MUT-06 persists the supplier reference before booking confirmation evidence', async () => {
    const key = `${suffix}-m06`
    const hold = await newHold(key)
    const adapter = counting()
    const result = await flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))
    expect(result.status).toBe('prebooked')
    const stored = await row(result.bookingId)
    expect(stored).toMatchObject({ status: 'ACKNOWLEDGED', supplierReference: result.supplierReference, supplierStatus: 'accepted' })
    expect(stored?.acknowledgedAt).toBeInstanceOf(Date)
    const detail = await queries.detail(tenantId, result.bookingId)
    expect(detail.supplierMutation).toMatchObject({
      bookingId: result.bookingId, mutationId: stored?.id, supplierKey: 'contracted-inventory', operation: 'PREBOOK', status: 'ACKNOWLEDGED', supplierReference: result.supplierReference,
    })
  })

  it('MUT-07 and MUT-16 recover confirmation when the booking update fails after acknowledgement', async () => {
    const key = `${suffix}-m07`
    const hold = await newHold(key)
    const failingBookings = Object.create(persistence) as BookingPersistenceService
    failingBookings.recordSupplierPrebook = async () => { throw new Error('booking down') }
    const adapter = counting()
    const result = await flow(journal, adapter.supplier, failingBookings).execute(commandFor(key, hold.holdId))
    expect(await row(result.bookingId)).toMatchObject({ status: 'ACKNOWLEDGED', supplierReference: result.supplierReference })
    const snapshot = (await prisma.booking.findUniqueOrThrow({ where: { id: result.bookingId } })).searchSnapshot as { supplierPrebook?: unknown }
    expect(snapshot.supplierPrebook).toBeUndefined()
    await backdate(hold.holdId)
    expect((await reconcile()).items).toContainEqual(expect.objectContaining({ bookingId: result.bookingId, outcome: 'prebooked_awaiting_confirmation' }))
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    const confirmed = await confirmation.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: result.bookingId })
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: false })
    expect(await confirmation.confirm({ tenantId, userId, requestId: `${key}-confirm-2`, bookingId: result.bookingId })).toMatchObject({ alreadyConfirmed: true })
    const nightsSold = await held()
    expect(nightsSold.every((night) => night.sold >= 1)).toBe(true)
  })

  it('MUT-08 keeps the supplier reference when the success audit insert fails', async () => {
    const key = `${suffix}-m08`
    const hold = await newHold(key)
    const selective = Object.create(audit) as AgentAuditService
    selective.record = async (input) => {
      if (input.action === 'booking.prebook.succeeded') throw new Error('audit down')
      return audit.record(input)
    }
    const adapter = counting()
    const result = await flow(journal, adapter.supplier, persistence, selective).execute(commandFor(key, hold.holdId))
    expect(await row(result.bookingId)).toMatchObject({ status: 'ACKNOWLEDGED', supplierReference: result.supplierReference })
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.prebook.succeeded', entityId: result.bookingId } })).toBe(0)
    await expect(confirmation.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: result.bookingId })).resolves.toMatchObject({ status: 'CONFIRMED' })
  })

  it('MUT-09 keeps acknowledged supplier success when booking and audit persistence both fail', async () => {
    const key = `${suffix}-m09`
    const hold = await newHold(key)
    const failingBookings = Object.create(persistence) as BookingPersistenceService
    failingBookings.recordSupplierPrebook = async () => { throw new Error('booking down') }
    const silentAudit = Object.create(audit) as AgentAuditService
    silentAudit.record = async (input) => {
      if (input.action === 'booking.prebook.succeeded' || input.action.startsWith('supplier.mutation.')) throw new Error('audit down')
      return audit.record(input)
    }
    const adapter = counting()
    const result = await flow(journal, adapter.supplier, failingBookings, silentAudit).execute(commandFor(key, hold.holdId))
    expect(result).toMatchObject({ status: 'prebooked' })
    expect(await row(result.bookingId)).toMatchObject({ status: 'ACKNOWLEDGED', supplierReference: result.supplierReference })
    expect(await prisma.auditEvent.count({ where: { tenantId, entityId: result.bookingId, action: 'booking.prebook.succeeded' } })).toBe(0)
  })

  it('MUT-10 leaves SENDING in place when the acknowledgement write fails', async () => {
    const key = `${suffix}-m10`
    const hold = await newHold(key)
    const before = await walletNet()
    const adapter = counting()
    await expect(flow(new AckFails(prisma, audit), adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('Supplier prebook requires reconciliation')
    expect(adapter.calls()).toBe(1)
    const booking = await prisma.booking.findFirstOrThrow({ where: { tenantId, idempotencyKey: key } })
    expect(await row(booking.id)).toMatchObject({ status: 'SENDING', supplierReference: null })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    expect(await walletNet()).toBe(before - 125099n)
    await expect(confirmation.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: booking.id })).rejects.toThrow('Supplier outcome is unknown')
  })

  it('MUT-11 allows one supplier invocation across 25 concurrent attempts', async () => {
    const key = `${suffix}-m11`
    const hold = await newHold(key)
    const adapter = counting()
    const before = await held()
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))))
    const fulfilled = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    expect(new Set(fulfilled.map((result) => result.bookingId)).size).toBe(1)
    expect(adapter.calls()).toBe(1)
    expect(await prisma.booking.count({ where: { tenantId, idempotencyKey: key } })).toBe(1)
    expect(await prisma.supplierMutation.count({ where: { tenantId, holdId: hold.holdId, operation: 'PREBOOK' } })).toBe(1)
    expect(await prisma.ledgerEntry.count({ where: { walletId, idempotencyKey: `booking:${fulfilled[0].bookingId}:authorize`, type: 'HOLD' } })).toBe(1)
    expect((await held()).map((night) => night.held)).toEqual(before.map((night) => night.held))
  })

  it('MUT-12 repeats reconciliation of an unknown mutation without a second side effect', async () => {
    const key = `${suffix}-m12`
    const hold = await newHold(key)
    const adapter = counting('timeout')
    await expect(flow(journal, adapter.supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('unknown')
    await backdate(hold.holdId)
    const first = await reconcile()
    const second = await reconcile()
    expect(first.items[0].outcome).toBe('manual_review_required')
    expect(second.items[0].outcome).toBe('manual_review_required')
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.reconciliation.manual_review', entityId: first.items[0].bookingId! } })).toBe(1)
  })

  it('MUT-13 denies cross-tenant journal reads, reconciliation and direct RLS access', async () => {
    const key = `${suffix}-m13`
    const hold = await newHold(key)
    const result = await flow(journal, counting().supplier).execute(commandFor(key, hold.holdId))
    expect(await journal.findForBooking(otherTenantId, result.bookingId, 'PREBOOK')).toBeNull()
    const stored = await row(result.bookingId)
    await expect(journal.resolve({ tenantId: otherTenantId, userId, mutationId: stored!.id, supplierStatus: 'accepted' })).rejects.toThrow('Supplier mutation is unavailable')
    const foreign = await new BookingReconciliationService(prisma, finance, holds, audit).reconcileStale({ tenantId: otherTenantId, userId, requestId: `${key}-foreign`, staleMinutes: 5 })
    expect(foreign.examined).toBe(0)
    expect(await row(result.bookingId)).toMatchObject({ status: 'ACKNOWLEDGED' })

    await prisma.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_mutation_rls_probe') THEN
        CREATE ROLE fbeds_mutation_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`)
    await prisma.$executeRawUnsafe(`GRANT fbeds_mutation_rls_probe TO CURRENT_USER`) // PostgreSQL 16: needed by a non-superuser owner to SET ROLE
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT ON "SupplierMutation" TO fbeds_mutation_rls_probe`)
    const visible = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${otherTenantId}, true)`
      await tx.$executeRawUnsafe(`SET LOCAL ROLE fbeds_mutation_rls_probe`)
      const rows = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "SupplierMutation"`)
      return rows[0].count
    })
    expect(visible).toBe(0n)
    const forced = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(Prisma.sql`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'SupplierMutation'`)
    expect(forced).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
  })

  it('MUT-14 does not expire a processing hold tied to an unresolved supplier mutation', async () => {
    const key = `${suffix}-m14`
    const hold = await newHold(key)
    const booking = await persistence.persistPending(commandFor(key, hold.holdId))
    await holds.beginProcessing(tenantId, hold.holdId, `${key}-req`, userId)
    const prepared = await journal.prepare({
      tenantId, userId, bookingId: booking.id, holdId: hold.holdId, supplierKey: 'contracted-inventory', operation: 'PREBOOK',
      idempotencyKey: `booking:${booking.id}:prebook`, requestId: `${key}-req`,
      fingerprint: supplierMutationFingerprint({ offerId: `offer-${key}`, searchId: `search-${key}`, holdId: hold.holdId, checkIn: '2099-04-01', checkOut: '2099-04-03', rooms: 1, adults: 2, children: 0, currency: 'AED', totalMinor: 125099 }),
    })
    await journal.markSending(tenantId, prepared.id, `${key}-req`, userId)
    await prisma.$executeRaw`UPDATE "InventoryHold" SET "created_at" = NOW() - INTERVAL '2 hours', "expires_at" = NOW() - INTERVAL '5 minutes' WHERE "id" = ${hold.holdId}`
    const before = await held()
    expect(await holds.expireDue(tenantId, new Date())).toBe(0)
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
    expect(await held()).toEqual(before)
  })

  it('MUT-15 refuses confirmation while the mutation is unknown', async () => {
    const key = `${suffix}-m15`
    const hold = await newHold(key)
    await expect(flow(journal, counting('timeout').supplier).execute(commandFor(key, hold.holdId))).rejects.toThrow('unknown')
    const booking = await prisma.booking.findFirstOrThrow({ where: { tenantId, idempotencyKey: key } })
    await expect(confirmation.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: booking.id })).rejects.toThrow('Supplier outcome is unknown')
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'PENDING_SUPPLIER' })
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject({ status: 'PROCESSING' })
  })
})
