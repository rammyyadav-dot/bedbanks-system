import { ConflictException, ForbiddenException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BookingTransactionCommand } from '@bedbanks/domain'
import { BookingPersistenceService } from './booking-persistence.service'

const command: BookingTransactionCommand = {
  tenantId: 'tenant-a', userId: 'user-a', requestId: 'request-a', idempotencyKey: 'booking-request-123',
  offerId: 'offer-a', searchId: 'search-a', inventoryHoldId: 'hold-a', canonicalHotelId: 'hotel-a',
  canonicalRoomTypeId: 'room-a', ratePlanId: 'plan-a', boardBasisId: 'board-a',
  checkIn: '2099-01-01', checkOut: '2099-01-03', rooms: 1, adults: 2, children: 0, childAges: [],
  currency: 'AED', totalMinor: 125099, leadGuest: { firstName: 'Test', lastName: 'Guest' },
}

const hold = {
  id: 'hold-a', tenantId: 'tenant-a', status: 'HELD', expiresAt: new Date('2099-01-01T12:00:00.000Z'),
  offerId: 'offer-a', searchId: 'search-a', ratePlanId: 'plan-a', canonicalHotelId: 'hotel-a',
  canonicalRoomTypeId: 'room-a', boardBasisId: 'board-a', checkIn: new Date('2099-01-01T00:00:00.000Z'),
  checkOut: new Date('2099-01-03T00:00:00.000Z'), rooms: 1, currency: 'AED', sellAmountMinor: 125099n,
}
const booking = {
  id: 'booking-a', tenantId: 'tenant-a', reference: 'FB-EXAMPLE', supplier: 'PENDING_SUPPLIER',
  hotelId: 'hotel-a', status: 'PENDING_SUPPLIER', currency: 'AED', totalMinor: 125099n,
  idempotencyKey: 'booking-request-123',
  searchSnapshot: {
    version: 1, requestId: 'request-a', offerId: 'offer-a', searchId: 'search-a', inventoryHoldId: 'hold-a',
    canonicalHotelId: 'hotel-a', canonicalRoomTypeId: 'room-a', ratePlanId: 'plan-a', boardBasisId: 'board-a',
    checkIn: '2099-01-01', checkOut: '2099-01-03', rooms: 1, adults: 2, children: 0, childAges: [],
    currency: 'AED', totalMinor: 125099, leadGuest: { firstName: 'Test', lastName: 'Guest' },
  },
}

function setup(overrides: { existing?: any; hold?: any; createError?: Error; agencyId?: string | null; plan?: any } = {}) {
  const tx = {
    booking: {
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? null),
      create: overrides.createError ? jest.fn().mockRejectedValue(overrides.createError) : jest.fn().mockResolvedValue(booking),
    },
    inventoryHold: { findFirst: jest.fn().mockResolvedValue(overrides.hold === undefined ? hold : overrides.hold) },
    ratePlan: { findFirst: jest.fn().mockResolvedValue(overrides.plan === undefined ? { cancellationPolicySet: null, contract: { tenantId: 'tenant-a', supplierId: 'supplier-a', cancellationPolicies: [{ policySet: null, daysBeforeCheckin: 7, penaltyPercent: 50, penaltyMinor: null, currency: null }] } } : overrides.plan) },
    agencyMember: { findUnique: jest.fn().mockResolvedValue(overrides.agencyId === null ? null : { agencyId: overrides.agencyId ?? 'agency-a' }) },
    roomType: { findFirst: jest.fn().mockResolvedValue({ name: 'Deluxe Sea View' }) },
    boardBasis: { findFirst: jest.fn().mockResolvedValue({ code: 'BB' }) },
    bookingRoom: { create: jest.fn().mockResolvedValue({ id: 'room-row-a' }) },
    bookingGuest: { create: jest.fn().mockResolvedValue({}) },
    bookingEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (tx: any) => Promise<any>) => work(tx)) }
  return { service: new BookingPersistenceService(prisma as any), tx, prisma }
}

describe('BookingPersistenceService', () => {
  it('freezes supplier ownership from hold -> rate plan -> contract in the creating transaction (ADR 0061 Amendment 1)', async () => {
    const { service, tx, prisma } = setup()
    await service.persistPending(command)
    expect(prisma.withTenant).toHaveBeenCalledTimes(1)
    expect(tx.ratePlan.findFirst).toHaveBeenCalledWith({ where: { id: 'plan-a', tenantId: 'tenant-a' }, select: { contract: { select: { tenantId: true, supplierId: true } } } })
    expect(tx.booking.create.mock.calls[0][0].data).toMatchObject({ supplierId: 'supplier-a', supplier: 'PENDING_SUPPLIER' })
  })

  it('records supplier ownership and cancellation terms from their separate plan reads', async () => {
    const { service, tx } = setup()
    tx.ratePlan.findFirst
      .mockResolvedValueOnce({ contract: { tenantId: 'tenant-a', supplierId: 'supplier-a' } })
      .mockResolvedValueOnce({ cancellationPolicySet: null, contract: { cancellationPolicies: [{ policySet: null, daysBeforeCheckin: 3, penaltyPercent: 25, penaltyMinor: null, currency: null }] } })
    await service.persistPending(command)
    expect(tx.ratePlan.findFirst).toHaveBeenCalledTimes(2)
    expect(tx.booking.create.mock.calls[0][0].data).toMatchObject({
      supplierId: 'supplier-a',
      cancellationPolicy: { rules: [{ daysBeforeCheckin: 3, penaltyPercent: 25 }], source: 'CONTRACT_AT_BOOKING' },
    })
  })

  it('refuses a command whose rate plan differs from the hold, before any ownership lookup', async () => {
    const { service, tx } = setup()
    await expect(service.persistPending({ ...command, ratePlanId: 'plan-from-request' })).rejects.toBeInstanceOf(ConflictException)
    expect(tx.ratePlan.findFirst).not.toHaveBeenCalled()
    expect(tx.booking.create).not.toHaveBeenCalled()
  })

  it('fails closed, creating nothing, when the plan or its contract cannot be resolved inside the tenant', async () => {
    for (const plan of [null, { contract: { tenantId: 'tenant-other', supplierId: 'supplier-a' } }, { contract: { tenantId: 'tenant-a', supplierId: '' } }]) {
      const { service, tx } = setup({ plan })
      await expect(service.persistPending(command)).rejects.toBeInstanceOf(ForbiddenException)
      expect(tx.booking.create).not.toHaveBeenCalled()
    }
  })

  it('does not re-resolve or rewrite ownership on an idempotent replay', async () => {
    const { service, tx } = setup({ existing: booking })
    await service.persistPending(command)
    expect(tx.ratePlan.findFirst).not.toHaveBeenCalled()
    expect(tx.booking.create).not.toHaveBeenCalled()
  })

  it('persists only PENDING after validating the authoritative hold', async () => {
    const { service, tx } = setup()
    await expect(service.persistPending(command)).resolves.toEqual(booking)
    expect(tx.inventoryHold.findFirst).toHaveBeenCalledWith({ where: { id: 'hold-a', tenantId: 'tenant-a' } })
    expect(tx.booking.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'PENDING_SUPPLIER', supplier: 'PENDING_SUPPLIER', currency: 'AED', totalMinor: 125099n,
    }) }))
  })

  it('rejects inaccessible, inactive, expired, or mismatched holds', async () => {
    await expect(setup({ hold: null }).service.persistPending(command)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(setup({ hold: { ...hold, status: 'RELEASED' } }).service.persistPending(command)).rejects.toBeInstanceOf(ConflictException)
    await expect(setup({ hold: { ...hold, expiresAt: new Date('2000-01-01T00:00:00.000Z') } }).service.persistPending(command)).rejects.toBeInstanceOf(ConflictException)
    await expect(setup({ hold: { ...hold, sellAmountMinor: 125100n } }).service.persistPending(command)).rejects.toBeInstanceOf(ConflictException)
    await expect(setup({ hold: { ...hold, canonicalRoomTypeId: 'room-other' } }).service.persistPending(command)).rejects.toBeInstanceOf(ConflictException)
  })

  it('returns an existing PENDING booking for an identical retry without touching inventory', async () => {
    const { service, tx } = setup({ existing: booking })
    await expect(service.persistPending(command)).resolves.toEqual(booking)
    expect(tx.inventoryHold.findFirst).not.toHaveBeenCalled()
    expect(tx.booking.create).not.toHaveBeenCalled()
  })

  it('treats a supplier-prebook overlay as the same commercial intent', async () => {
    const overlaid = { ...booking, searchSnapshot: { ...booking.searchSnapshot, supplierPrebook: { outcome: 'unknown', code: 'timeout' } } }
    const { service, tx } = setup({ existing: overlaid })
    await expect(service.persistPending(command)).resolves.toEqual(overlaid)
    expect(tx.booking.create).not.toHaveBeenCalled()
  })

  it('rejects reuse of the booking idempotency key with different immutable intent', async () => {
    const { service } = setup({ existing: { ...booking, totalMinor: 1n } })
    await expect(service.persistPending(command)).rejects.toBeInstanceOf(ConflictException)
  })

  it('recovers a concurrent booking unique-key race in a fresh tenant transaction', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.2.1' })
    const { service, tx, prisma } = setup({ createError: p2002 })
    tx.booking.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(booking)
    await expect(service.persistPending(command)).resolves.toEqual(booking)
    expect(prisma.withTenant).toHaveBeenCalledTimes(2)
  })

  it('writes the promoted columns, the room, the lead guest and the first lifecycle event in the same transaction (ADR 0039)', async () => {
    const { service, tx, prisma } = setup({ hold: { ...hold, rooms: 2 } })
    await service.persistPending({ ...command, rooms: 2, agencyReference: '  AG-REF-1  ' })
    expect(prisma.withTenant).toHaveBeenCalledTimes(1) // one transaction
    expect(tx.booking.create.mock.calls[0][0].data).toMatchObject({
      channel: 'PORTAL', agencyId: 'agency-a', agentUserId: 'user-a', agentRef: 'AG-REF-1', checkIn: new Date('2099-01-01T00:00:00.000Z'), checkOut: new Date('2099-01-03T00:00:00.000Z'), nights: 2,
    })
    // Finding F13: the contract's cancellation terms are frozen onto the booking in the same transaction
    expect(tx.booking.create.mock.calls[0][0].data.cancellationPolicy).toMatchObject({ rules: [{ daysBeforeCheckin: 7, penaltyPercent: 50 }], setName: null, source: 'CONTRACT_AT_BOOKING' })
    expect(tx.agencyMember.findUnique).toHaveBeenCalledWith({ where: { tenantId_userId: { tenantId: 'tenant-a', userId: 'user-a' } }, select: { agencyId: true } })
    expect(tx.bookingRoom.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-a', bookingId: 'booking-a', quantity: 2, roomName: 'Deluxe Sea View', boardCode: 'BB', adults: 2, children: 0, sellMinor: 125099n })
    expect(tx.bookingGuest.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-a', bookingId: 'booking-a', roomId: 'room-row-a', firstName: 'Test', lastName: 'Guest', isLead: true })
    expect(tx.bookingEvent.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-a', bookingId: 'booking-a', fromStatus: null, toStatus: 'PENDING_SUPPLIER', actorType: 'USER', actorId: 'user-a' })
    expect(JSON.stringify(tx.bookingEvent.create.mock.calls[0][0].data)).not.toMatch(/Guest|Test/) // no guest name in the log
  })

  it('leaves the agency null (Unassigned) when the booking user has no agency membership', async () => {
    const { service, tx } = setup({ agencyId: null })
    await service.persistPending(command)
    expect(tx.booking.create.mock.calls[0][0].data.agencyId).toBeNull()
  })

  it('does not expose a supplier confirmation or payment side effect', async () => {
    const { service, tx } = setup()
    await service.persistPending(command)
    const data = tx.booking.create.mock.calls[0][0].data
    expect(data.status).toBe('PENDING_SUPPLIER')
    expect(data.supplier).toBe('PENDING_SUPPLIER')
    expect(data).not.toHaveProperty('supplierReference')
    expect(data).not.toHaveProperty('paymentReference')
  })

  it('records an unknown supplier outcome beside the commercial snapshot and does not downgrade a prebook', async () => {
    const tx = {
      booking: {
        findFirst: jest.fn().mockResolvedValue(booking),
        update: jest.fn().mockResolvedValue(booking),
      },
    }
    const prisma = { withTenant: jest.fn(async (_tenant: string, work: (client: typeof tx) => Promise<unknown>) => work(tx)) }
    const service = new BookingPersistenceService(prisma as never)
    await service.recordSupplierPrebook('tenant-a', 'booking-a', { outcome: 'unknown', code: 'timeout' })
    const written = tx.booking.update.mock.calls[0][0].data.searchSnapshot
    expect(written.supplierPrebook).toEqual({ outcome: 'unknown', code: 'timeout' })
    expect(written.totalMinor).toBe(125099)
    expect(written.offerId).toBe('offer-a')

    tx.booking.findFirst.mockResolvedValue({ ...booking, searchSnapshot: written })
    tx.booking.update.mockClear()
    await service.recordSupplierPrebook('tenant-a', 'booking-a', { outcome: 'unknown', code: 'timeout' })
    expect(tx.booking.update).not.toHaveBeenCalled()
    await expect(service.recordSupplierPrebook('tenant-a', 'booking-a', { outcome: 'prebooked', supplierReference: 'supplier-ref' })).resolves.toBeUndefined()
    tx.booking.findFirst.mockResolvedValue({ ...booking, searchSnapshot: { ...written, supplierPrebook: { outcome: 'prebooked', supplierReference: 'supplier-ref' } } })
    await expect(service.recordSupplierPrebook('tenant-a', 'booking-a', { outcome: 'unknown', code: 'timeout' })).rejects.toBeInstanceOf(ConflictException)
  })
})
