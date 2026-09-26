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
  hotelId: 'hotel-a', status: 'PENDING', currency: 'AED', totalMinor: 125099n,
  idempotencyKey: 'booking-request-123',
  searchSnapshot: {
    version: 1, requestId: 'request-a', offerId: 'offer-a', searchId: 'search-a', inventoryHoldId: 'hold-a',
    canonicalHotelId: 'hotel-a', canonicalRoomTypeId: 'room-a', ratePlanId: 'plan-a', boardBasisId: 'board-a',
    checkIn: '2099-01-01', checkOut: '2099-01-03', rooms: 1, adults: 2, children: 0, childAges: [],
    currency: 'AED', totalMinor: 125099, leadGuest: { firstName: 'Test', lastName: 'Guest' },
  },
}

function setup(overrides: { existing?: any; hold?: any; createError?: Error } = {}) {
  const tx = {
    booking: {
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? null),
      create: overrides.createError ? jest.fn().mockRejectedValue(overrides.createError) : jest.fn().mockResolvedValue(booking),
    },
    inventoryHold: { findFirst: jest.fn().mockResolvedValue(overrides.hold === undefined ? hold : overrides.hold) },
  }
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (tx: any) => Promise<any>) => work(tx)) }
  return { service: new BookingPersistenceService(prisma as any), tx, prisma }
}

describe('BookingPersistenceService', () => {
  it('persists only PENDING after validating the authoritative hold', async () => {
    const { service, tx } = setup()
    await expect(service.persistPending(command)).resolves.toEqual(booking)
    expect(tx.inventoryHold.findFirst).toHaveBeenCalledWith({ where: { id: 'hold-a', tenantId: 'tenant-a' } })
    expect(tx.booking.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'PENDING', supplier: 'PENDING_SUPPLIER', currency: 'AED', totalMinor: 125099n,
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

  it('does not expose a supplier confirmation or payment side effect', async () => {
    const { service, tx } = setup()
    await service.persistPending(command)
    const data = tx.booking.create.mock.calls[0][0].data
    expect(data.status).toBe('PENDING')
    expect(data.supplier).toBe('PENDING_SUPPLIER')
    expect(data).not.toHaveProperty('supplierReference')
    expect(data).not.toHaveProperty('paymentReference')
  })
})
