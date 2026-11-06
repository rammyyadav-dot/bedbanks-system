import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { provisionApiRuntimeRole } from '../src/database/api-runtime-role'
import { certifyBookingExecutionRole, deprovisionBookingExecutionRole, provisionBookingExecutionRole } from '../src/database/booking-execution-role'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { SupplierMutationJournalService } from '../src/agent/supplier-mutation-journal.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import { BookingDocumentService } from '../src/agent/booking-document.service'
import { BookingCancellationService } from '../src/agent/booking-cancellation.service'
import { CancellationPolicyService } from '../src/agent/cancellation-policy.service'
import { LedgerService } from '../src/agent/ledger.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'
import { eraseLedger } from './ledger-erasure'

/**
 * ADR 0113: the agent booking transaction runs as fbeds_booking_exec, not as the owner and not as fbeds_api.
 * The owner client only seeds and observes. BOOKING_ENABLED stays unset so the services use the client they were given,
 * which is the execution login.
 */
const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')

describe('booking execution role (ADR 0113)', () => {
  const owner = new PrismaClient()
  const suffix = `bkx-${Date.now()}-${randomBytes(3).toString('hex')}`
  const execLogin = `fbeds_bkx_${randomBytes(4).toString('hex')}`
  const strictLogin = `fbeds_rtx_${randomBytes(4).toString('hex')}`
  const execPassword = randomBytes(24).toString('hex')
  const strictPassword = randomBytes(24).toString('hex')
  const nights = [new Date('2099-03-01'), new Date('2099-03-02')]
  let exec: PrismaService
  let strict: PrismaClient
  let tenantId: string
  let userId: string
  let supplierId: string
  let hotelId: string
  let roomId: string
  let boardId: string
  let contractId: string
  let ratePlanId: string
  let walletId: string

  const loginUrl = (role: string, password: string) => {
    const url = new URL(ownerUrl)
    url.username = role
    url.password = password
    return url.toString()
  }

  beforeAll(async () => {
    await owner.$connect()
    await provisionBookingExecutionRole(owner, { loginRole: execLogin, password: execPassword })
    await provisionApiRuntimeRole(owner, { loginRole: strictLogin, password: strictPassword })
    exec = new PrismaService({ datasourceUrl: loginUrl(execLogin, execPassword) })
    strict = new PrismaClient({ datasourceUrl: loginUrl(strictLogin, strictPassword) })
    await exec.$connect()
    await strict.$connect()
    tenantId = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await owner.user.create({ data: { email: `${suffix}@example.test` } })).id
    await owner.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await owner.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await owner.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await owner.roomType.create({ data: { hotelId, name: 'R', code: suffix.slice(0, 12), maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await owner.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    contractId = (await owner.contract.create({ data: { tenantId, supplierId, code: suffix.slice(0, 20), status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    await owner.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 3, penaltyPercent: 100 } })
    ratePlanId = (await owner.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix.slice(0, 20), status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await owner.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 5 })) })
    walletId = (await makeAgencyBooker(owner, tenantId, userId, 100_000_000n)).walletId
  }, 60000)

  afterAll(async () => {
    await exec?.$disconnect()
    await strict?.$disconnect()
    if (tenantId) {
      await owner.bookingDocument.deleteMany({ where: { tenantId } }).catch(() => undefined)
      await owner.bookingEmail.deleteMany({ where: { tenantId } }).catch(() => undefined)
      await owner.auditEvent.deleteMany({ where: { tenantId } })
      const bookings = await owner.booking.findMany({ where: { tenantId }, select: { id: true } })
      if (bookings.length) await owner.cancellation.deleteMany({ where: { bookingId: { in: bookings.map((b) => b.id) } } })
      await eraseLedger(owner, { where: { tenantId } })
      await owner.supplierMutation.deleteMany({ where: { tenantId } })
      await owner.booking.deleteMany({ where: { tenantId } })
      await owner.inventoryHoldNight.deleteMany({ where: { tenantId } })
      await owner.inventoryHold.deleteMany({ where: { tenantId } })
      await owner.wallet.deleteMany({ where: { tenantId } })
      await removeAgencyBookers(owner, tenantId)
      await owner.dailyAvailability.deleteMany({ where: { ratePlanId } })
      await owner.cancellationPolicy.deleteMany({ where: { contractId } })
      await owner.ratePlan.delete({ where: { id: ratePlanId } }).catch(() => undefined)
      await owner.contract.delete({ where: { id: contractId } }).catch(() => undefined)
      await owner.boardBasis.delete({ where: { id: boardId } }).catch(() => undefined)
      await owner.roomType.delete({ where: { id: roomId } }).catch(() => undefined)
      await owner.hotel.delete({ where: { id: hotelId } }).catch(() => undefined)
      await owner.supplier.delete({ where: { id: supplierId } }).catch(() => undefined)
      await owner.membership.deleteMany({ where: { tenantId } })
      await owner.user.delete({ where: { id: userId } }).catch(() => undefined)
      await owner.tenant.delete({ where: { id: tenantId } }).catch(() => undefined)
    }
    await deprovisionBookingExecutionRole(owner, execLogin).catch(() => undefined)
    await deprovisionBookingExecutionRole(owner, strictLogin).catch(() => undefined)
    await owner.$disconnect()
  })

  it('certifies the execution login: every allowed probe passes and every forbidden write is denied', async () => {
    const cert = await certifyBookingExecutionRole(exec)
    expect({ role: cert.role.failures, probes: cert.probes.filter((probe) => !probe.ok).map((probe) => probe.name) }).toEqual({ role: [], probes: [] })
  })

  it('completes hold, prebook, confirm, document and cancel as the execution login', async () => {
    const audit = new AgentAuditService(exec)
    const holds = new InventoryHoldService(exec)
    const persistence = new BookingPersistenceService(exec)
    const finance = new BookingFinancialAuthorizationService(exec)
    const journal = new SupplierMutationJournalService(exec, audit)
    const confirmation = new BookingConfirmationService(exec)
    const supplier = { prebook: async () => ({ supplierReference: 'contracted:test' }) } as unknown as SupplierAdapter
    const tx = new BookingTransactionService(exec, new SupplierPrebookOrchestrationService(persistence, finance, new PrebookCompensationRecoveryService(finance, holds, audit), holds, audit, journal, supplier), confirmation)
    const documents = new BookingDocumentService(exec, audit)
    const cancellation = new BookingCancellationService(exec, new CancellationPolicyService(), new LedgerService(exec), audit)
    const key = `${suffix}-life`
    const hold = await holds.create({
      tenantId, userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId,
      canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, checkIn: '2099-03-01', checkOut: '2099-03-03', rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-03-01T12:00:00.000Z',
    })
    const pre = await tx.prebook({ tenantId, userId, requestId: `${key}-pre`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Test', lastName: 'Guest' } })
    const done = await tx.confirm({ tenantId, userId, requestId: `${key}-confirm`, bookingId: pre.bookingId })
    expect(done).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: false })
    const voucher = await documents.get({ tenantId, userId, requestId: `${key}-doc`, bookingId: pre.bookingId, type: 'VOUCHER' })
    expect(voucher.alreadyIssued).toBe(false)
    const cancelled = await cancellation.cancel({ tenantId, userId, requestId: `${key}-cancel`, bookingId: pre.bookingId, reason: 'guest' })
    expect(cancelled).toMatchObject({ status: 'CANCELLED', alreadyCancelled: false })
    const note = await documents.get({ tenantId, userId, requestId: `${key}-cn`, bookingId: pre.bookingId, type: 'CREDIT_NOTE' })
    expect(note.type).toBe('CREDIT_NOTE')

    expect(await owner.booking.findUniqueOrThrow({ where: { id: pre.bookingId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await owner.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { held: true, sold: true } })).toEqual([{ held: 0, sold: 0 }, { held: 0, sold: 0 }])
    expect(await owner.ledgerEntry.findMany({ where: { walletId, reference: `booking:${pre.bookingId}` }, orderBy: { immutableAt: 'asc' }, select: { type: true, amountMinor: true } })).toEqual([
      { type: 'HOLD', amountMinor: -125099n },
      { type: 'RELEASE', amountMinor: 125099n },
      { type: 'DEBIT', amountMinor: -125099n },
      { type: 'REFUND', amountMinor: 125099n },
    ])
  })

  it('denies a price change and an identity read on the execution login, and denies a booking insert on the strict runtime login', async () => {
    await expect(exec.$executeRawUnsafe(`UPDATE "Booking" SET "total_minor" = "total_minor" WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(exec.$executeRawUnsafe(`UPDATE "Wallet" SET "credit_limit" = "credit_limit" WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(exec.$queryRawUnsafe(`SELECT "id" FROM users WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(strict.$executeRawUnsafe(`INSERT INTO "Booking" ("id") SELECT 'x' WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(strict.$executeRawUnsafe(`INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`)).rejects.toThrow(/permission denied/)
  })
})
