import { BadRequestException, ConflictException } from '@nestjs/common'
import { bookingAccountFor } from './agency-account'
import { BookingTransactionService } from './booking-transaction.service'

jest.mock('./agency-account', () => ({ bookingAccountFor: jest.fn() }))

const hold = {
  id: 'hold-a',
  offerId: 'offer-a',
  searchId: 'search-a',
  ratePlanId: 'plan-a',
  canonicalHotelId: 'hotel-a',
  canonicalRoomTypeId: 'room-a',
  boardBasisId: 'board-a',
  checkIn: new Date('2099-03-01T00:00:00.000Z'),
  checkOut: new Date('2099-03-03T00:00:00.000Z'),
  rooms: 1,
  currency: 'AED',
  sellAmountMinor: 125099n,
}
const input = {
  tenantId: 'tenant-a', userId: 'user-a', requestId: 'req-a', inventoryHoldId: 'hold-a', idempotencyKey: 'key-a',
  adults: 2, children: 0, childAges: [] as number[], leadGuest: { firstName: 'Test', lastName: 'Guest' },
}

function setup(opts: { hold?: typeof hold | null; plan?: Record<string, unknown> | null } = {}) {
  const tx = {
    inventoryHold: { findFirst: jest.fn().mockResolvedValue(opts.hold === undefined ? hold : opts.hold) },
    ratePlan: { findFirst: jest.fn().mockResolvedValue(opts.plan === undefined ? { occupancy: 2, roomType: { maxAdults: 2, maxChildren: 0 } } : opts.plan) },
    agencyMember: { findFirst: jest.fn().mockResolvedValue({ agencyId: 'agency-a' }) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
  }
  ;(bookingAccountFor as jest.Mock).mockResolvedValue({ id: 'wallet-a', agencyId: 'agency-a' })
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (t: typeof tx) => Promise<unknown>) => work(tx)) }
  const prebookFlow = { execute: jest.fn().mockResolvedValue({ status: 'prebooked', bookingId: 'booking-a' }) }
  const confirmation = { confirm: jest.fn().mockResolvedValue({ status: 'CONFIRMED', alreadyConfirmed: false }) }
  const service = new BookingTransactionService(prisma as never, prebookFlow as never, confirmation as never)
  return { service, tx, prebookFlow, confirmation, prisma }
}

describe('BookingTransactionService (unit)', () => {
  it('reads the hold server-side and prebooks against the agency wallet, never a client-chosen account', async () => {
    const { service, prebookFlow } = setup()
    await expect(service.prebook(input)).resolves.toEqual({ status: 'prebooked', bookingId: 'booking-a' })
    expect(bookingAccountFor).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'user-a', 'AED')
    expect(prebookFlow.execute).toHaveBeenCalledWith(expect.objectContaining({
      inventoryHoldId: 'hold-a', walletId: 'wallet-a', currency: 'AED', totalMinor: 125099,
      checkIn: '2099-03-01', checkOut: '2099-03-03', canonicalHotelId: 'hotel-a',
    }))
  })

  it('refuses a missing hold, a missing rate plan, and occupancy that does not match the held rate', async () => {
    await expect(setup({ hold: null }).service.prebook(input)).rejects.toBeInstanceOf(ConflictException)
    await expect(setup({ plan: null }).service.prebook(input)).rejects.toThrow('Rate plan is unavailable')
    const occupancy = setup()
    await expect(occupancy.service.prebook({ ...input, adults: 3 })).rejects.toBeInstanceOf(BadRequestException)
    expect(occupancy.prebookFlow.execute).not.toHaveBeenCalled()
  })

  it('delegates confirmation to BookingConfirmationService with the authenticated tenant', async () => {
    const { service, confirmation } = setup()
    await service.confirm({ tenantId: 'tenant-a', userId: 'user-a', requestId: 'req-b', bookingId: 'booking-a' })
    expect(confirmation.confirm).toHaveBeenCalledWith({ tenantId: 'tenant-a', userId: 'user-a', requestId: 'req-b', bookingId: 'booking-a' })
  })
})
