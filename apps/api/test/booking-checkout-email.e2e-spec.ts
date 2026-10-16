import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
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
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import { BookingEmailDispatcher } from '../src/booking-ops/email/booking-email-dispatcher.service'
import { EmailSendError, type EmailSender } from '../src/booking-ops/email/email-sender.port'
import { provisionBookingOpsRole, BOOKING_OPS_LOGIN_ROLE } from '../src/database/booking-ops-role'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'

jest.setTimeout(120_000)

/**
 * ADR 0066 on PostgreSQL: checkout details (every guest by room, agent reference, special requests), the confirmation email queued in the
 * confirming transaction, the documents built from it, and the dispatcher sending through the booking module's own limited role.
 */
describe('booking checkout details and confirmation email (PostgreSQL)', () => {
  const ownerUrl = process.env.DATABASE_URL
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const docs = new BookingDocumentService(prisma, audit)
  const cancellations = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:test' }) } as unknown as SupplierAdapter
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, new SupplierMutationJournalService(prisma, audit), supplier), new BookingConfirmationService(prisma))
  const opsPassword = `ops-${randomBytes(20).toString('hex')}`
  const opsUrl = (() => { const u = new URL(ownerUrl as string); u.username = BOOKING_OPS_LOGIN_ROLE; u.password = opsPassword; return u.toString() })()
  const opsDb = new BookingOpsDatabase({ DATABASE_URL: ownerUrl, BOOKING_OPS_DATABASE_URL: opsUrl })
  const suffix = `ce-${Date.now()}-${randomBytes(3).toString('hex')}`
  const nights = [new Date('2099-05-01'), new Date('2099-05-02')]
  let tenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, ratePlanId: string

  const sent: Array<{ to: string[]; cc: string[]; raw: string }> = []
  let nextFailure: EmailSendError | null = null
  const sender: EmailSender = { name: 'fake', configured: () => true, send: async (envelope, raw) => {
    if (nextFailure) { const failure = nextFailure; nextFailure = null; throw failure }
    sent.push({ to: envelope.to, cc: envelope.cc, raw }); return { messageId: `msg-${sent.length}` }
  } }
  const dispatcher = new BookingEmailDispatcher(opsDb, sender, { EMAIL_FROM: 'fBeds Reservations <reservations@fbeds.example>', AGENT_PORTAL_URL: 'https://agent.fbeds.example/bookings' })

  const hold = (key: string, rooms = 2) => holds.create({ tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
    canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-05-01', checkOut: '2099-05-03', rooms, currency: 'AED', sellAmountMinor: 180000, offerExpiresAt: '2099-05-01T12:00:00.000Z' })
  const lead = { firstName: 'Layla', lastName: "O'Hara" }
  const guests = [
    { roomNumber: 1, type: 'ADULT' as const, title: 'Mrs' as const, firstName: 'Layla', lastName: "O'Hara" },
    { roomNumber: 1, type: 'ADULT' as const, title: 'Mr' as const, firstName: 'Omar', lastName: "O'Hara" },
    { roomNumber: 2, type: 'ADULT' as const, title: 'Ms' as const, firstName: 'Sara', lastName: 'Khan' },
    { roomNumber: 2, type: 'ADULT' as const, firstName: 'Ali', lastName: 'Khan' },
  ]
  const book = async (key: string, confirm: { recipient?: string | null; cc?: string[] } = { recipient: 'agent@agency.example', cc: ['ops@agency.example'] }) => {
    const h = await hold(key)
    const pre = await tx.prebook({ tenantId, userId, requestId: `${key}-pre`, inventoryHoldId: h.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: lead,
      guests, agentRef: 'TR-2099/0501', specialRequests: { codes: ['LATE_CHECK_IN', 'QUIET_ROOM'], note: 'Arriving after 23:00' } })
    const done = await tx.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: pre.bookingId, ...confirm })
    return { bookingId: pre.bookingId, done }
  }
  const issue = async (bookingId: string) => { for (const type of ['VOUCHER', 'INVOICE'] as const) await docs.get({ tenantId, userId, requestId: `doc-${type}`, bookingId, type }) }
  const emailOf = (bookingId: string) => prisma.bookingEmail.findUniqueOrThrow({ where: { tenantId_bookingId_kind: { tenantId, bookingId, kind: 'BOOKING_CONFIRMATION' } } })

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: `${suffix} Travel`, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: 'Marina Bay Suites', propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: '1 Marina Walk', contentStatus: 'COMPLETE' } })).id
    await prisma.hotelProfile.create({ data: { tenantId, hotelId, shortDescription: 'x', checkInTime: '15:00', checkOutTime: '12:00', contacts: { reservations: { email: 'private@hotel.example' } }, updatedById: userId } as never })
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Deluxe King', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: 'Bed and Breakfast' } })).id
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    await prisma.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 7, penaltyPercent: 100 } })
    ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 40 })) })
    await makeAgencyBooker(prisma, tenantId, userId, 100_000_000n)
    await provisionBookingOpsRole(prisma, { password: opsPassword })
  })

  afterAll(async () => {
    await opsDb.onModuleDestroy()
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.bookingDocument.deleteMany({ where: { tenantId } })
    await prisma.supplierMutation.deleteMany({ where: { tenantId } })
    await prisma.cancellation.deleteMany({ where: { booking: { tenantId } } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await removeAgencyBookers(prisma, tenantId)
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId } })
    await prisma.ratePlan.delete({ where: { id: ratePlanId } })
    await prisma.cancellationPolicy.deleteMany({ where: { contractId } })
    await prisma.contract.delete({ where: { id: contractId } })
    await prisma.boardBasis.delete({ where: { id: boardId } })
    await prisma.roomType.delete({ where: { id: roomId } })
    await prisma.hotelProfile.deleteMany({ where: { hotelId } })
    await prisma.hotel.delete({ where: { id: hotelId } })
    await prisma.supplier.delete({ where: { id: supplierId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('CE-01: every guest is stored by room, with agent reference and special requests; the email is queued once, in the confirming transaction', async () => {
    const { bookingId, done } = await book(`${suffix}-full`)
    expect(done).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: false, email: { to: 'agent@agency.example', cc: ['ops@agency.example'] } })
    const rows = await prisma.bookingGuest.findMany({ where: { bookingId }, orderBy: [{ roomNumber: 'asc' }, { isLead: 'desc' }] })
    expect(rows.map((g) => [g.roomNumber, g.title, g.firstName, g.isLead])).toEqual([[1, 'Mrs', 'Layla', true], [1, 'Mr', 'Omar', false], [2, 'Ms', 'Sara', false], [2, null, 'Ali', false]])
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })
    expect(booking).toMatchObject({ agentRef: 'TR-2099/0501', specialRequests: { codes: ['LATE_CHECK_IN', 'QUIET_ROOM'], note: 'Arriving after 23:00' } })
    expect(await emailOf(bookingId)).toMatchObject({ status: 'QUEUED', toAddress: 'agent@agency.example', ccAddresses: ['ops@agency.example'], attempt: 0 })
    // A replayed confirmation reports the same email and queues nothing more.
    expect(await tx.confirm({ tenantId, userId, requestId: 'again', bookingId, recipient: 'other@agency.example' })).toMatchObject({ alreadyConfirmed: true, email: { to: 'agent@agency.example' } })
    expect(await prisma.bookingEmail.count({ where: { bookingId } })).toBe(1)
    // The audit trail records the queueing without any address.
    const queued = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, entityId: bookingId, action: 'booking.email.queued' } })
    expect(JSON.stringify(queued.payload)).not.toMatch(/@/)
  })

  it('CE-02: no recipient, no email; and a confirmation without details still works as before', async () => {
    const h = await hold(`${suffix}-plain`, 1)
    const pre = await tx.prebook({ tenantId, userId, requestId: 'plain', inventoryHoldId: h.holdId, idempotencyKey: `${suffix}-plain`, adults: 2, children: 0, childAges: [], leadGuest: lead })
    expect(await tx.confirm({ tenantId, userId, requestId: 'plain-c', bookingId: pre.bookingId, recipient: null })).toMatchObject({ status: 'CONFIRMED', email: null })
    expect(await prisma.bookingEmail.count({ where: { bookingId: pre.bookingId } })).toBe(0)
    expect(await prisma.bookingGuest.findMany({ where: { bookingId: pre.bookingId }, select: { roomNumber: true, isLead: true } })).toEqual([{ roomNumber: 1, isLead: true }])
  })

  it('CE-03: the voucher carries the rooming list, special requests, agent ref and hotel times, but no hotel contact; the invoice names the agency', async () => {
    const { bookingId } = await book(`${suffix}-docs`)
    const voucher = await docs.get({ tenantId, userId, requestId: 'v', bookingId, type: 'VOUCHER' })
    expect(voucher.payload).toMatchObject({ agentRef: 'TR-2099/0501', hotelDetails: { address: '1 Marina Walk', checkInTime: '15:00', checkOutTime: '12:00' },
      specialRequests: { items: ['Late check-in', 'Quiet room'], note: 'Arriving after 23:00' },
      guestsByRoom: [{ room: 1, guests: [{ name: "Mrs Layla O'Hara", isLead: true }, { name: "Mr Omar O'Hara" }] }, { room: 2, guests: [{ name: 'Ms Sara Khan' }, { name: 'Ali Khan' }] }] })
    expect(JSON.stringify(voucher.payload)).not.toContain('private@hotel.example')
    const invoice = await docs.get({ tenantId, userId, requestId: 'i', bookingId, type: 'INVOICE' })
    expect(invoice.payload).toMatchObject({ agencyName: expect.stringContaining('Booker agency'), agentRef: 'TR-2099/0501', totalMinor: '180000', currency: 'AED' })
  })

  it('CE-04: the dispatcher, on the booking role, sends once with both documents attached and records SENT; nothing is sent twice', async () => {
    const { bookingId } = await book(`${suffix}-send`)
    await issue(bookingId)
    sent.length = 0
    expect(await dispatcher.runOnce()).toBeGreaterThanOrEqual(1)
    const subjectOf = (raw: string) => { const header = /\r\nSubject: (.*)\r\n/.exec(raw)?.[1] ?? ''; const word = /^=\?UTF-8\?B\?(.*)\?=$/.exec(header); return word ? Buffer.from(word[1], 'base64').toString('utf8') : header }
    const reference = (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).reference
    const mine = sent.filter((m) => subjectOf(m.raw).includes(reference))
    expect(mine).toHaveLength(1)
    expect(subjectOf(mine[0].raw)).toBe(`Booking confirmed: Marina Bay Suites · 2099-05-01 · ${reference}`)
    const raw = mine[0].raw
    expect(raw).toMatch(/^From: fBeds Reservations <reservations@fbeds\.example>\r\nTo: agent@agency\.example\r\nCc: ops@agency\.example\r\n/)
    expect(raw).toMatch(/filename="Voucher-VCH-FB-[A-Z0-9]+\.html"/); expect(raw).toMatch(/filename="Invoice-INV-FB-[A-Z0-9]+\.html"/)
    const html = Buffer.from(raw.split('Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8')
    expect(html).toContain('Marina Bay Suites'); expect(html).toContain('AED 1,800.00'); expect(html).toContain('https://agent.fbeds.example/bookings'); expect(html).not.toContain('<script')
    const row = await emailOf(bookingId)
    expect(row).toMatchObject({ status: 'SENT', attempt: 1, providerMessageId: expect.stringMatching(/^msg-/), lastErrorCode: null })
    expect(row.sentAt).not.toBeNull()
    const before = sent.length
    await dispatcher.runOnce()
    expect(sent.length).toBe(before)
    const evt = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, entityId: bookingId, action: 'booking.email.sent' } })
    expect(JSON.stringify(evt.payload)).not.toMatch(/@|Layla/)
  })

  it('CE-05: missing documents and transient failures retry later; a permanent rejection fails; a cancelled booking is never announced', async () => {
    const pending = await book(`${suffix}-nodocs`)
    await dispatcher.runOnce()
    expect(await emailOf(pending.bookingId)).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'DOCUMENTS_PENDING', attempt: 1 })
    const due = (await emailOf(pending.bookingId)).runAfter.getTime() - Date.now()
    expect(due).toBeGreaterThan(50_000); expect(due).toBeLessThan(70_000)

    const transient = await book(`${suffix}-transient`)
    await issue(transient.bookingId)
    nextFailure = new EmailSendError('SES_THROTTLING', false)
    await dispatcher.runOnce(() => new Date(Date.now() + 120_000))
    const afterTransient = await emailOf(transient.bookingId)
    expect(['RETRY_WAIT', 'SENT']).toContain(afterTransient.status)

    const rejected = await book(`${suffix}-rejected`)
    await issue(rejected.bookingId)
    await prisma.bookingEmail.updateMany({ where: { bookingId: { not: rejected.bookingId }, tenantId, status: { in: ['QUEUED', 'RETRY_WAIT'] } }, data: { runAfter: new Date('2100-01-01') } })
    nextFailure = new EmailSendError('SES_MESSAGEREJECTED', true)
    await dispatcher.runOnce()
    expect(await emailOf(rejected.bookingId)).toMatchObject({ status: 'FAILED', lastErrorCode: 'SES_MESSAGEREJECTED', sentAt: null })

    const cancelled = await book(`${suffix}-cancelled`)
    await issue(cancelled.bookingId)
    await cancellations.cancel({ tenantId, userId, requestId: 'cx', bookingId: cancelled.bookingId, reason: 'client changed plans' } as never)
    sent.length = 0
    await dispatcher.runOnce()
    expect(await emailOf(cancelled.bookingId)).toMatchObject({ status: 'FAILED', lastErrorCode: 'BOOKING_NOT_CONFIRMED' })
    expect(sent.filter((m) => m.raw.includes(cancelled.done.reference))).toHaveLength(0)
  })

  it('CE-06: the booking role can move an email through its states but can never change who it goes to', async () => {
    const { bookingId } = await book(`${suffix}-guard`)
    const ops = new PrismaClient({ datasourceUrl: opsUrl })
    try {
      await expect(ops.$transaction(async (t) => {
        await t.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantId}', true)`)
        await t.$executeRawUnsafe(`UPDATE "BookingEmail" SET "to_address" = 'attacker@evil.example' WHERE "booking_id" = '${bookingId}'`)
      })).rejects.toThrow(/permission denied/i)
    } finally { await ops.$disconnect() }
    expect((await emailOf(bookingId)).toAddress).toBe('agent@agency.example')
  })
})
