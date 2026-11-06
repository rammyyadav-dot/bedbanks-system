import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { BookingQueryService } from './booking-query.service'
import { BookingConfirmationService } from './booking-confirmation.service'
import { BookingCancellationService } from './booking-cancellation.service'
import { BookingDocumentService } from './booking-document.service'

/**
 * Two agencies share one tenant. The datasource applies whatever predicate the service sends.
 * A missing agency predicate would return both agencies.
 */
const TENANT = 'tenant-a'

type StoredBooking = {
  id: string
  tenantId: string
  agencyId: string | null
  reference: string
  status: 'CONFIRMED'
  currency: string
  totalMinor: bigint
  createdAt: Date
  hotelId: string
  searchSnapshot: Record<string, unknown>
  documents: Array<{ type: string; number: string }>
  supplierMutations: []
  cancellations: []
}

type Person = { userId: string; role: string; agencyId?: string; permissions?: string[]; revokedAt?: Date | null; tenantStatus?: string }

function booking(id: string, agencyId: string | null): StoredBooking {
  return {
    id, tenantId: TENANT, agencyId, reference: id, status: 'CONFIRMED', currency: 'AED', totalMinor: 100n,
    createdAt: new Date('2026-01-02T00:00:00.000Z'), hotelId: 'hotel-1',
    searchSnapshot: { checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, adults: 2, children: 0, leadGuest: { firstName: 'Ada', lastName: 'Lovelace' } },
    documents: [], supplierMutations: [], cancellations: [],
  }
}

function matches(row: StoredBooking, where: { tenantId?: string; id?: string; agencyId?: string; status?: { in?: string[] } }) {
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false
  if (where.id !== undefined && row.id !== where.id) return false
  if (Object.prototype.hasOwnProperty.call(where, 'agencyId') && row.agencyId !== where.agencyId) return false
  if (where.status?.in && !where.status.in.includes(row.status)) return false
  return true
}

function datasource(people: Person[], bookings: StoredBooking[]) {
  const listWheres: Array<Record<string, unknown>> = []
  const created: unknown[] = []
  const person = (userId: string, tenantId: string) => tenantId === TENANT ? people.find((item) => item.userId === userId) : undefined
  const lock = (query: { strings?: string[]; values?: unknown[] }) => {
    const text = (query.strings ?? []).join(' ')
    const [id, tenantId, agencyId] = query.values ?? []
    return bookings
      .filter((row) => row.id === id && row.tenantId === tenantId && (!text.includes('agency_id') || row.agencyId === agencyId))
      .map((row) => ({ id: row.id }))
  }
  const tx = {
    membership: {
      findUnique: async ({ where }: { where: { userId_tenantId: { userId: string; tenantId: string } } }) => {
        const found = person(where.userId_tenantId.userId, where.userId_tenantId.tenantId)
        if (!found) return null
        return { role: found.role, revokedAt: found.revokedAt ?? null, tenantId: TENANT, tenant: { status: found.tenantStatus ?? 'ACTIVE' } }
      },
    },
    agencyMember: {
      findUnique: async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => {
        const found = person(where.tenantId_userId.userId, where.tenantId_userId.tenantId)
        return found?.agencyId ? { agencyId: found.agencyId } : null
      },
    },
    userRole: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        const found = people.find((item) => item.userId === where.userId)
        return (found?.permissions ?? []).map((key) => ({ role: { permissions: [{ permission: { key } }] } }))
      },
    },
    booking: {
      count: async ({ where }: { where: Record<string, unknown> }) => bookings.filter((row) => matches(row, where)).length,
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        listWheres.push(where)
        return bookings.filter((row) => matches(row, where))
      }),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => bookings.find((row) => matches(row, where)) ?? null,
      findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const found = bookings.find((row) => matches(row, where))
        if (!found) throw new Error('No Booking found')
        return found
      },
      update: jest.fn(),
    },
    hotel: { findMany: async () => [{ id: 'hotel-1', name: 'Harbour' }] },
    auditEvent: { findFirst: async () => null, create: jest.fn(), count: jest.fn() },
    bookingEmail: { findUnique: async () => null, create: jest.fn() },
    bookingDocument: {
      findUnique: async ({ where }: { where: { bookingId_type: { bookingId: string; type: string } } }) => ({
        id: `doc-${where.bookingId_type.bookingId}`, type: where.bookingId_type.type, number: `VCH-${where.bookingId_type.bookingId}`,
        issuedAt: new Date('2026-01-03T00:00:00.000Z'), payload: { bookingReference: where.bookingId_type.bookingId },
      }),
      create: jest.fn(async (input: unknown) => { created.push(input); return input }),
    },
    cancellation: { create: jest.fn(), findUniqueOrThrow: jest.fn() },
    inventoryHold: { update: jest.fn() },
    $queryRaw: jest.fn(async (query: { strings?: string[]; values?: unknown[] }) => lock(query)),
  }
  const prisma = { withTenant: async (_tenant: string, work: (client: typeof tx) => Promise<unknown>) => work(tx) }
  return { prisma, tx, listWheres, created }
}

const people: Person[] = [
  { userId: 'agent-a', role: 'agent', agencyId: 'agency-a', permissions: ['booking.read'] },
  { userId: 'agent-b', role: 'agent', agencyId: 'agency-b', permissions: ['booking.read'] },
  { userId: 'owner-agent', role: 'owner', agencyId: 'agency-a', permissions: ['booking.read'] },
  { userId: 'operator-owner', role: 'owner' },
  { userId: 'operator-formal', role: 'agent', permissions: ['booking.read'] },
  { userId: 'stranger', role: 'agent' },
  { userId: 'revoked', role: 'owner', revokedAt: new Date('2026-01-01T00:00:00.000Z') },
]
const bookings = [booking('b-a', 'agency-a'), booking('b-b', 'agency-b'), booking('b-none', null)]

function services() {
  const store = datasource(people, bookings)
  const audit = { record: jest.fn().mockResolvedValue(undefined) }
  return {
    ...store,
    queries: new BookingQueryService(store.prisma as never),
    confirmation: new BookingConfirmationService(store.prisma as never),
    cancellations: new BookingCancellationService(store.prisma as never, {} as never, {} as never, audit as never),
    documents: new BookingDocumentService(store.prisma as never, audit as never),
  }
}

describe('Agent booking agency scope inside one tenant', () => {
  it('lists only the caller agency and hides the other agency and unassigned bookings', async () => {
    const { queries, listWheres } = services()
    const page = await queries.list(TENANT, 'agent-a')
    expect(page.items.map((item) => item.id)).toEqual(['b-a'])
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ hotelName: 'Harbour', leadGuest: 'Ada Lovelace', totalMinor: '100' })
    expect(listWheres[0]).toMatchObject({ tenantId: TENANT, agencyId: 'agency-a' })
    expect(listWheres[0]).not.toHaveProperty('id')

    const other = await queries.list(TENANT, 'agent-b')
    expect(other.items.map((item) => item.id)).toEqual(['b-b'])
    expect(listWheres.at(-1)).toMatchObject({ agencyId: 'agency-b' })
  })

  it('refuses a direct booking id from the other agency, including an unassigned booking', async () => {
    const { queries } = services()
    expect((await queries.detail(TENANT, 'agent-a', 'b-a')).id).toBe('b-a')
    await expect(queries.detail(TENANT, 'agent-a', 'b-b')).rejects.toBeInstanceOf(NotFoundException)
    await expect(queries.detail(TENANT, 'agent-a', 'b-none')).rejects.toBeInstanceOf(NotFoundException)
    await expect(queries.detail(TENANT, 'agent-b', 'b-a')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('keeps an owner who belongs to an agency inside that agency', async () => {
    const { queries } = services()
    expect((await queries.list(TENANT, 'owner-agent')).items.map((item) => item.id)).toEqual(['b-a'])
    await expect(queries.detail(TENANT, 'owner-agent', 'b-b')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('gives operator read, and only operator read, every agency plus unassigned bookings', async () => {
    const { queries, listWheres } = services()
    for (const userId of ['operator-owner', 'operator-formal']) {
      const page = await queries.list(TENANT, userId)
      expect(page.items.map((item) => item.id).sort()).toEqual(['b-a', 'b-b', 'b-none'])
      expect(listWheres.at(-1)).not.toHaveProperty('agencyId')
      expect((await queries.detail(TENANT, userId, 'b-b')).id).toBe('b-b')
      expect((await queries.detail(TENANT, userId, 'b-none')).id).toBe('b-none')
    }
  })

  it('refuses a caller with no agency and no operator read, and a revoked membership', async () => {
    const { queries, tx } = services()
    await expect(queries.list(TENANT, 'stranger')).rejects.toBeInstanceOf(ForbiddenException)
    await expect(queries.detail(TENANT, 'stranger', 'b-a')).rejects.toBeInstanceOf(ForbiddenException)
    await expect(queries.list(TENANT, 'revoked')).rejects.toBeInstanceOf(ForbiddenException)
    expect(tx.booking.findMany).not.toHaveBeenCalled()
  })

  it('does not confirm, quote, cancel or issue a document for the other agency booking id', async () => {
    const { confirmation, cancellations, documents, tx } = services()
    const other = { tenantId: TENANT, userId: 'agent-a', requestId: 'req', bookingId: 'b-b' }
    await expect(confirmation.confirm(other)).rejects.toBeInstanceOf(NotFoundException)
    await expect(cancellations.quote(other)).rejects.toBeInstanceOf(NotFoundException)
    await expect(cancellations.cancel({ ...other, reason: 'guest' })).rejects.toBeInstanceOf(NotFoundException)
    await expect(documents.get({ ...other, type: 'VOUCHER' })).rejects.toBeInstanceOf(NotFoundException)
    expect(tx.booking.update).not.toHaveBeenCalled()
    expect(tx.cancellation.create).not.toHaveBeenCalled()
    expect(tx.bookingDocument.create).not.toHaveBeenCalled()
    expect(tx.bookingEmail.create).not.toHaveBeenCalled()
    expect(tx.inventoryHold.update).not.toHaveBeenCalled()

    await expect(confirmation.confirm({ ...other, bookingId: 'b-a' })).resolves.toMatchObject({ bookingId: 'b-a', alreadyConfirmed: true })
    await expect(documents.get({ ...other, bookingId: 'b-a', type: 'VOUCHER' })).resolves.toMatchObject({ number: 'VCH-b-a' })
    await expect(cancellations.quote({ ...other, bookingId: 'b-a' })).rejects.toThrow('incomplete')
    await expect(cancellations.cancel({ ...other, bookingId: 'b-a', reason: 'guest' })).rejects.toThrow('incomplete')
    expect(tx.cancellation.create).not.toHaveBeenCalled()
    expect(tx.bookingDocument.create).not.toHaveBeenCalled()
  })

  it('lets an operator act on another agency booking id', async () => {
    const { confirmation, documents } = services()
    const command = { tenantId: TENANT, userId: 'operator-formal', requestId: 'req', bookingId: 'b-b' }
    await expect(confirmation.confirm(command)).resolves.toMatchObject({ bookingId: 'b-b', alreadyConfirmed: true })
    await expect(documents.get({ ...command, type: 'VOUCHER' })).resolves.toMatchObject({ number: 'VCH-b-b' })
    await expect(documents.get({ ...command, bookingId: 'b-none', type: 'VOUCHER' })).resolves.toMatchObject({ number: 'VCH-b-none' })
  })
})
