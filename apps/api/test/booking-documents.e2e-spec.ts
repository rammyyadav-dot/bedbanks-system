import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { SupplierMutationJournalService } from '../src/agent/supplier-mutation-journal.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import { BookingCancellationService } from '../src/agent/booking-cancellation.service'
import { CancellationPolicyService } from '../src/agent/cancellation-policy.service'
import { LedgerService } from '../src/agent/ledger.service'
import { BookingDocumentService } from '../src/agent/booking-document.service'
import { renderBookingDocument } from '../src/agent/booking-document.render'
import { BookingQueryService } from '../src/agent/booking-query.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'

describe('booking documents (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const docs = new BookingDocumentService(prisma, audit)
  const queries = new BookingQueryService(prisma)
  const cancellations = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:test' }) } as unknown as SupplierAdapter
  const journal = new SupplierMutationJournalService(prisma, audit)
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, journal, supplier), confirmation)
  const suffix = `docs-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nights = [new Date('2099-03-01'), new Date('2099-03-02')]
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string

  const newHold = (key: string) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-03-01T12:00:00.000Z' })

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
    await makeAgencyBooker(prisma, tenantId, userId, 100_000_000n) // ADR 0028 slice 3: the booker's agency account
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.bookingDocument.deleteMany({ where: { tenantId } })
    await prisma.supplierMutation.deleteMany({ where: { tenantId } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await removeAgencyBookers(prisma, tenantId)
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

  const guest = { firstName: 'Layla', lastName: "O'Hara" }
  const bookConfirmed = async (key: string) => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment: 20 } })
    const hold = await newHold(key)
    const pre = await tx.prebook({ tenantId, userId, requestId: `${key}-req`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest })
    await tx.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: pre.bookingId })
    return pre.bookingId
  }
  const get = (bookingId: string, type: 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE', t = tenantId) => docs.get({ tenantId: t, userId, requestId: `doc-${Math.random()}`, bookingId, type })

  it('issues a voucher and invoice once, with deterministic numbers and a frozen snapshot', async () => {
    await prisma.cancellationPolicy.deleteMany({ where: { contractId } })
    await prisma.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 7, penaltyPercent: 100 } })
    const bookingId = await bookConfirmed(`${suffix}-a`)
    const reference = (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).reference

    const voucher = await get(bookingId, 'VOUCHER')
    expect(voucher).toMatchObject({ type: 'VOUCHER', number: `VCH-${reference}`, alreadyIssued: false, bookingStatus: 'CONFIRMED' })
    expect(voucher.payload).toMatchObject({ bookingReference: reference, hotel: { city: 'Dubai' }, stay: { checkIn: '2099-03-01', checkOut: '2099-03-03', nights: 2, rooms: 1, adults: 2 }, leadGuest: guest, cancellationPolicy: [{ daysBeforeCheckin: 7, penalty: '100% of the booking total' }] })
    expect(JSON.stringify(voucher.payload)).not.toContain('125099') // a voucher carries no price

    const invoice = await get(bookingId, 'INVOICE')
    expect(invoice).toMatchObject({ number: `INV-${reference}`, alreadyIssued: false })
    expect(invoice.payload).toMatchObject({ currency: 'AED', totalMinor: '125099', payment: { method: 'wallet', status: 'PAID' }, lines: [{ amountMinor: '125099' }] })

    // idempotent and frozen: renaming the hotel afterwards does not change what was issued
    await prisma.hotel.update({ where: { id: hotelId }, data: { name: 'Renamed Hotel' } })
    const again = await get(bookingId, 'VOUCHER')
    expect(again).toMatchObject({ id: voucher.id, issuedAt: voucher.issuedAt, alreadyIssued: true })
    expect(again.payload.hotel.name).toBe(voucher.payload.hotel.name)
    expect(renderBookingDocument({ ...again, bookingStatus: again.bookingStatus })).toContain('O&#39;Hara')
    expect(await prisma.bookingDocument.count({ where: { bookingId } })).toBe(2)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.document.issued', entityId: bookingId } })).toBe(2)

    // the database itself rejects edits
    await expect(prisma.bookingDocument.update({ where: { id: voucher.id }, data: { number: 'TAMPERED-1' } })).rejects.toThrow(/immutable/i)
    expect((await prisma.bookingDocument.findUniqueOrThrow({ where: { id: voucher.id } })).number).toBe(`VCH-${reference}`)
  })

  it('converges 25 simultaneous requests on one document', async () => {
    const bookingId = await bookConfirmed(`${suffix}-race`)
    const results = await Promise.all(Array.from({ length: 25 }, () => get(bookingId, 'INVOICE')))
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(results.filter((result) => !result.alreadyIssued)).toHaveLength(1)
    expect(await prisma.bookingDocument.count({ where: { bookingId, type: 'INVOICE' } })).toBe(1)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.document.issued', entityId: bookingId } })).toBe(1)
  })

  it('refuses ineligible documents and foreign tenants', async () => {
    const bookingId = await bookConfirmed(`${suffix}-elig`)
    await expect(get(bookingId, 'CREDIT_NOTE')).rejects.toThrow('only for a cancelled booking')
    const hold = await newHold(`${suffix}-pending`)
    const pending = await tx.prebook({ tenantId, userId, requestId: 'p', inventoryHoldId: hold.holdId, idempotencyKey: `${suffix}-pending`, adults: 2, children: 0, childAges: [], leadGuest: guest })
    await expect(get(pending.bookingId, 'VOUCHER')).rejects.toThrow('only for a confirmed booking')
    await expect(get(pending.bookingId, 'INVOICE')).rejects.toThrow('only for a charged booking')
    await expect(get('does-not-exist', 'VOUCHER')).rejects.toThrow('Booking not found')
    const other = await prisma.tenant.create({ data: { name: `${suffix}-other`, slug: `${suffix}-other` } })
    try { await expect(get(bookingId, 'VOUCHER', other.id)).rejects.toThrow('Booking not found') } finally { await prisma.tenant.delete({ where: { id: other.id } }) }
    await holds.release(tenantId, hold.holdId, 'cleanup', { type: 'USER', userId })
  })

  it('issues a credit note after cancellation with exact penalty and refund, and flags earlier documents as cancelled', async () => {
    await prisma.cancellationPolicy.deleteMany({ where: { contractId } })
    await prisma.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 50_000, penaltyPercent: 30 } })
    const bookingId = await bookConfirmed(`${suffix}-cn`)
    const voucher = await get(bookingId, 'VOUCHER')
    await cancellations.cancel({ tenantId, userId, requestId: 'cancel-cn', bookingId })

    const note = await get(bookingId, 'CREDIT_NOTE')
    expect(note.payload).toMatchObject({ currency: 'AED', totalMinor: '125099', penaltyMinor: '37529', refundMinor: '87570' })
    expect(note.payload.originalInvoiceNumber).toBe(`INV-${(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).reference}`)
    expect(BigInt(note.payload.penaltyMinor) + BigInt(note.payload.refundMinor)).toBe(125099n)
    const invoice = await get(bookingId, 'INVOICE') // issued late, from the frozen booking data
    expect(invoice.alreadyIssued).toBe(false)
    const reprint = await get(bookingId, 'VOUCHER')
    expect(reprint).toMatchObject({ id: voucher.id, bookingStatus: 'CANCELLED' })
    expect(renderBookingDocument(reprint)).toContain('THIS BOOKING HAS BEEN CANCELLED')
    expect(renderBookingDocument(note)).toContain('AED 875.70')
  })

  it('lists and describes bookings for the agent portal, tenant-scoped, with integer-string amounts', async () => {
    const bookingId = await bookConfirmed(`${suffix}-view`)
    await get(bookingId, 'VOUCHER')
    const list = await queries.list(tenantId, { limit: 50 })
    const row = list.items.find((booking) => booking.id === bookingId)!
    expect(row).toMatchObject({ status: 'CONFIRMED', currency: 'AED', totalMinor: '125099', checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, leadGuest: "Layla O'Hara" })
    expect(row.hotelName).toBeTruthy()
    expect(list.items.length).toBeLessThanOrEqual(list.limit)
    expect(list.total).toBeGreaterThanOrEqual(list.items.length)
    expect(list.items.map((booking) => booking.createdAt)).toEqual([...list.items.map((booking) => booking.createdAt)].sort().reverse())
    const detail = await queries.detail(tenantId, bookingId)
    expect(detail).toMatchObject({ cancellable: true, adults: 2, children: 0, documents: [{ type: 'VOUCHER' }] })
    expect((await queries.detail(tenantId, bookingId, new Date('2099-03-01T00:00:00.000Z'))).cancellable).toBe(false)
    const other = await prisma.tenant.create({ data: { name: `${suffix}-q`, slug: `${suffix}-q` } })
    try {
      expect(await queries.list(other.id)).toMatchObject({ items: [], total: 0, offset: 0 })
      await expect(queries.detail(other.id, bookingId)).rejects.toThrow('Booking not found')
    } finally { await prisma.tenant.delete({ where: { id: other.id } }) }
  })
})
