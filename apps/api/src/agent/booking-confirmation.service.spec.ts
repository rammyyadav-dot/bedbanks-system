import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { BookingConfirmationService } from './booking-confirmation.service'
import { moveNight } from '../inventory/inventory-counters'
import { appendLedgerEntry } from '../ledger/ledger-core'
import { transitionBooking } from '../booking-ops/booking-transition'

jest.mock('../inventory/inventory-counters', () => ({ moveNight: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../ledger/ledger-core', () => ({ appendLedgerEntry: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../booking-ops/booking-transition', () => ({ transitionBooking: jest.fn().mockResolvedValue(undefined) }))

const command = { tenantId: 'tenant-a', userId: 'user-a', requestId: 'req-a', bookingId: 'booking-a' }
const sqlText = (query: { strings?: string[]; sql?: string; text?: string }) => [...(query.strings ?? []), query.sql ?? '', query.text ?? ''].join(' ')
const nights = [{ holdId: 'hold-a', tenantId: 'tenant-a' }, { holdId: 'hold-a', tenantId: 'tenant-a' }]

function setup(opts: {
  locked?: boolean
  booking?: Record<string, unknown>
  mutation?: Record<string, unknown> | null
  prebookedCount?: number
  hold?: Array<{ id: string; status: string }>
  reservation?: Record<string, unknown> | null
  walletLocked?: boolean
  released?: boolean
  nights?: typeof nights
  agencyId?: string | null
  membershipRole?: string
  operatorPermissions?: string[]
} = {}) {
  const booking = {
    id: 'booking-a',
    tenantId: 'tenant-a',
    reference: 'FB-CONFIRM',
    status: 'PENDING_SUPPLIER',
    totalMinor: 125099,
    currency: 'AED',
    searchSnapshot: { inventoryHoldId: 'hold-a' },
    ...opts.booking,
  }
  const mutation = opts.mutation === undefined
    ? { status: 'ACKNOWLEDGED', supplierStatus: 'accepted', supplierReference: 'contracted:hold-a' }
    : opts.mutation
  const reservation = opts.reservation === undefined
    ? { walletId: 'wallet-a', amountMinor: -125099, currency: 'AED', type: 'HOLD' }
    : opts.reservation
  const tx = {
    $queryRaw: jest.fn()
      .mockResolvedValueOnce(opts.locked === false ? [] : [{ id: 'booking-a' }])
      .mockResolvedValueOnce(opts.hold ?? [{ id: 'hold-a', status: 'PROCESSING' }])
      .mockResolvedValueOnce(opts.walletLocked === false ? [] : [{ id: 'wallet-a' }]),
    booking: {
      findFirstOrThrow: jest.fn().mockResolvedValue(booking),
      update: jest.fn().mockResolvedValue(booking),
    },
    bookingEmail: {
      findUnique: jest.fn().mockResolvedValue({ toAddress: 'agent@example.test', ccAddresses: [] }),
      create: jest.fn().mockResolvedValue({}),
    },
    supplierMutation: { findFirst: jest.fn().mockResolvedValue(mutation) },
    auditEvent: {
      count: jest.fn().mockResolvedValue(opts.prebookedCount ?? 0),
      create: jest.fn().mockResolvedValue({}),
    },
    ledgerEntry: {
      findFirst: jest.fn()
        .mockResolvedValueOnce(reservation)
        .mockResolvedValueOnce(reservation)
        .mockResolvedValueOnce(opts.released ? { id: 'release-a' } : null),
    },
    inventoryHoldNight: { findMany: jest.fn().mockResolvedValue(opts.nights ?? nights) },
    inventoryHold: { update: jest.fn().mockResolvedValue({}) },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ role: opts.membershipRole ?? 'agent', revokedAt: null, tenantId: 'tenant-a', tenant: { status: 'ACTIVE' } }),
    },
    agencyMember: {
      findUnique: jest.fn().mockResolvedValue(opts.agencyId === null ? null : { agencyId: opts.agencyId ?? 'agency-a' }),
    },
    userRole: {
      findMany: jest.fn().mockResolvedValue((opts.operatorPermissions ?? []).map((key) => ({ role: { permissions: [{ permission: { key } }] } }))),
    },
  }
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (t: typeof tx) => Promise<unknown>) => work(tx)) }
  return { service: new BookingConfirmationService(prisma as never), tx, prisma }
}

describe('BookingConfirmationService (unit)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('confirms a prebooked booking once: inventory, ledger settle, lifecycle, audit', async () => {
    const { service, tx } = setup()
    await expect(service.confirm(command)).resolves.toEqual({
      bookingId: 'booking-a', reference: 'FB-CONFIRM', status: 'CONFIRMED', alreadyConfirmed: false, email: null,
    })
    expect(moveNight).toHaveBeenCalledTimes(2)
    expect(appendLedgerEntry).toHaveBeenCalledTimes(2)
    expect(appendLedgerEntry).toHaveBeenCalledWith(tx, expect.objectContaining({ type: 'RELEASE', amountMinor: 125099, idempotencyKey: 'booking:booking-a:authorize:settle-release' }))
    expect(appendLedgerEntry).toHaveBeenCalledWith(tx, expect.objectContaining({ type: 'DEBIT', amountMinor: -125099, idempotencyKey: 'booking:booking-a:authorize:settle-debit' }))
    expect(transitionBooking).toHaveBeenCalledWith(tx, expect.objectContaining({ bookingId: 'booking-a', action: 'systemConfirm', expectedStatus: 'PENDING_SUPPLIER', idempotencyKey: 'confirm:booking-a' }))
    expect(tx.inventoryHold.update).toHaveBeenCalledWith({ where: { id: 'hold-a', tenantId: 'tenant-a' }, data: { status: 'CONFIRMED' } })
    expect(tx.booking.update).toHaveBeenCalledWith({ where: { id: 'booking-a', tenantId: 'tenant-a' }, data: { supplier: 'contracted-inventory' } })
    expect(tx.booking.findFirstOrThrow).toHaveBeenCalledWith({ where: { agencyId: 'agency-a', id: 'booking-a', tenantId: 'tenant-a' } })
    expect(sqlText(tx.$queryRaw.mock.calls[0][0])).toContain('agency_id')
    expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'booking.confirmed', entityId: 'booking-a' }) }))
  })

  it('queues the confirmation email in the same tenant transaction when a recipient is supplied', async () => {
    const { service, tx } = setup()
    await expect(service.confirm({ ...command, recipient: 'agent@example.test', cc: ['ops@example.test'] })).resolves.toMatchObject({
      alreadyConfirmed: false, email: { to: 'agent@example.test', cc: ['ops@example.test'] },
    })
    expect(tx.bookingEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bookingId: 'booking-a', kind: 'BOOKING_CONFIRMATION', toAddress: 'agent@example.test', ccAddresses: ['ops@example.test'] }),
    })
  })

  it('is idempotent for an already confirmed booking and does not move money or stock again', async () => {
    const { service, tx } = setup({ booking: { status: 'CONFIRMED' } })
    await expect(service.confirm(command)).resolves.toEqual({
      bookingId: 'booking-a', reference: 'FB-CONFIRM', status: 'CONFIRMED', alreadyConfirmed: true,
      email: { to: 'agent@example.test', cc: [] },
    })
    expect(moveNight).not.toHaveBeenCalled()
    expect(appendLedgerEntry).not.toHaveBeenCalled()
    expect(transitionBooking).not.toHaveBeenCalled()
    expect(tx.inventoryHold.update).not.toHaveBeenCalled()
  })

  it('refuses a missing booking, a booking that is not confirmable, and a missing prebook', async () => {
    await expect(setup({ locked: false }).service.confirm(command)).rejects.toBeInstanceOf(NotFoundException)
    await expect(setup({ booking: { status: 'CANCELLED' } }).service.confirm(command)).rejects.toThrow('not confirmable')
    await expect(setup({ mutation: null, prebookedCount: 0, booking: { searchSnapshot: { inventoryHoldId: 'hold-a' } } }).service.confirm(command)).rejects.toThrow('not been prebooked')
    expect(moveNight).not.toHaveBeenCalled()
  })

  it('refuses an unknown supplier outcome instead of confirming', async () => {
    await expect(setup({ mutation: { status: 'UNKNOWN', supplierStatus: 'unknown', supplierReference: null } }).service.confirm(command)).rejects.toThrow('unknown')
    await expect(setup({ mutation: { status: 'SENDING', supplierStatus: null, supplierReference: null } }).service.confirm(command)).rejects.toThrow('unknown')
  })

  it('refuses when the inventory hold is not PROCESSING, has no nights, or the wallet lock is missing', async () => {
    await expect(setup({ hold: [{ id: 'hold-a', status: 'HELD' }] }).service.confirm(command)).rejects.toThrow('no longer active')
    await expect(setup({ nights: [] }).service.confirm(command)).rejects.toThrow('no nights')
    await expect(setup({ walletLocked: false }).service.confirm(command)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('refuses a reservation that does not match the booking or that was already released', async () => {
    await expect(setup({ reservation: { walletId: 'wallet-a', amountMinor: -1, currency: 'AED' } }).service.confirm(command)).rejects.toThrow('does not match')
    await expect(setup({ reservation: null }).service.confirm(command)).rejects.toThrow('unavailable')
    await expect(setup({ released: true }).service.confirm(command)).rejects.toThrow('was released')
    expect(appendLedgerEntry).not.toHaveBeenCalled()
    expect(transitionBooking).not.toHaveBeenCalled()
  })

  it('does not confirm another agency booking in the same tenant', async () => {
    const { service, tx } = setup({ agencyId: 'agency-b', locked: false })
    await expect(service.confirm(command)).rejects.toBeInstanceOf(NotFoundException)
    const query = tx.$queryRaw.mock.calls[0][0]
    expect(sqlText(query)).toContain('agency_id')
    expect(query.values).toEqual(['booking-a', 'tenant-a', 'agency-b'])
    expect(tx.booking.findFirstOrThrow).not.toHaveBeenCalled()
    expect(tx.booking.update).not.toHaveBeenCalled()
    expect(moveNight).not.toHaveBeenCalled()
    expect(appendLedgerEntry).not.toHaveBeenCalled()
  })

  it('lets an operator with no agency confirm any booking in the tenant', async () => {
    const { service, tx } = setup({ agencyId: null, membershipRole: 'owner' })
    await expect(service.confirm(command)).resolves.toMatchObject({ bookingId: 'booking-a', status: 'CONFIRMED' })
    expect(sqlText(tx.$queryRaw.mock.calls[0][0])).not.toContain('agency_id')
    expect(tx.booking.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'booking-a', tenantId: 'tenant-a' } })
  })

  it('refuses a caller who has neither an agency nor operator read', async () => {
    const { service, tx } = setup({ agencyId: null, membershipRole: 'agent' })
    await expect(service.confirm(command)).rejects.toBeInstanceOf(ForbiddenException)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.booking.update).not.toHaveBeenCalled()
  })
})
