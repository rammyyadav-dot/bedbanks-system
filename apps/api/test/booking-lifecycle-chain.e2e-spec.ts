import { randomBytes } from 'node:crypto'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { OfferHoldService } from '../src/agent/offer-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { SupplierMutationJournalService } from '../src/agent/supplier-mutation-journal.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import { BookingCancellationService } from '../src/agent/booking-cancellation.service'
import { BookingDocumentService } from '../src/agent/booking-document.service'
import { CancellationPolicyService } from '../src/agent/cancellation-policy.service'
import { LedgerService } from '../src/agent/ledger.service'
import { transitionBooking } from '../src/booking-ops/booking-transition'
import { applyAmendmentDecision, prepareAmendmentDecision, recordAmendmentRequest } from '../src/booking-ops/booking-amendment'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import type { AuthenticatedUser } from '../src/auth/interfaces/authenticated-user.interface'
import { makeAgencyBooker, removeAgencyBookers } from './support/agency-booker'
import { eraseLedger } from './ledger-erasure'

jest.setTimeout(120_000)

/**
 * The booking lifecycle end to end on real PostgreSQL, through the real services:
 * recheck -> hold -> prebook -> confirm -> voucher/invoice -> amendment -> cancellation -> credit note,
 * with a replay of every mutating step and concurrent races on the steps that move inventory or money.
 * The amendment step composes the same functions the Admin actions service composes (record/prepare/transition/apply in one transaction).
 */
describe('booking lifecycle chain (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const journal = new SupplierMutationJournalService(prisma, audit)
  const cancellations = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const documents = new BookingDocumentService(prisma, audit)
  const suffix = `chain-${Date.now()}-${randomBytes(3).toString('hex')}`
  const stay = { checkIn: '2099-03-01', checkOut: '2099-03-03' }
  const price = 125099
  let tenantId = '', userId = '', supplierId = '', hotelId = '', roomId = '', boardId = '', contractId = '', ratePlanId = '', walletId = '', hotelMappingId = '', roomMappingId = ''
  let recheckResult: { status: string; offer?: object } = { status: 'available' }
  const supplier = { name: 'chain-test-adapter', search: jest.fn(), prebook: async () => ({ supplierReference: 'contracted:chain' }), cancel: jest.fn(), recheck: jest.fn(async () => recheckResult) } as unknown as SupplierAdapter
  const offerHolds = new OfferHoldService(supplier, prisma, holds, audit)
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, journal, supplier), confirmation)
  const actor = () => ({ user: { id: userId } }) as AuthenticatedUser

  const offerFor = (key: string, over: Partial<{ checkIn: string; checkOut: string; sellAmountMinor: number }> = {}) => ({
    offerId: `offer-${key}`, searchId: `search-${key}`, supplierId, supplierHotelId: `${suffix}-sh`, supplierRoomId: `${suffix}-sr`, canonicalHotelId: hotelId, canonicalRoomTypeId: roomId,
    ratePlanId, boardBasisId: boardId, ...stay, rooms: 1, adults: 2, children: 0, childAges: [], currency: 'AED', sellAmountMinor: price, expiresAt: '2099-03-01T12:00:00.000Z', ...over,
  })
  const holdOffer = (key: string, requestKey = key, expectedSellAmountMinor = price) => {
    recheckResult = { status: 'available', offer: offerFor(key) }
    return offerHolds.execute({ offerId: `offer-${key}`, searchId: `search-${key}`, expectedCurrency: 'AED', expectedSellAmountMinor, idempotencyKey: requestKey, tenantId, requestId: `${requestKey}-req`, user: actor() })
  }
  const guest = { firstName: 'Chain', lastName: 'Guest' }
  const prebook = (key: string, holdId: string) => tx.prebook({ tenantId, userId, requestId: `${key}-pre`, inventoryHoldId: holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest })
  const confirm = (bookingId: string) => tx.confirm({ tenantId, userId, requestId: `confirm-${randomBytes(4).toString('hex')}`, bookingId })
  const cancel = (bookingId: string) => cancellations.cancel({ tenantId, userId, requestId: `cancel-${randomBytes(4).toString('hex')}`, bookingId, reason: 'guest request' })
  const doc = (bookingId: string, type: 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE') => documents.get({ tenantId, userId, requestId: `doc-${randomBytes(4).toString('hex')}`, bookingId, type })
  const grid = () => prisma.dailyAvailability.findMany({ where: { ratePlanId }, orderBy: { stayDate: 'asc' }, select: { stayDate: true, allotment: true, held: true, sold: true } })
  const ledgerTypes = (bookingId: string) => prisma.ledgerEntry.findMany({ where: { walletId, reference: `booking:${bookingId}` }, orderBy: { immutableAt: 'asc' }, select: { type: true, amountMinor: true } })
  const walletNet = async () => (await prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n
  const resetInventory = async (allotment: number) => {
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId }, data: { allotment, held: 0, sold: 0 } })
  }
  const bookedThrough = async (key: string) => {
    const held = await holdOffer(key)
    const pre = await prebook(key, held.holdId!)
    await confirm(pre.bookingId)
    return { holdId: held.holdId!, bookingId: pre.bookingId }
  }

  /** Request then decide an amendment in one transaction each, exactly as BookingActionsService composes them. */
  const amend = async (bookingId: string, proposal: object, approval: { sellMinor: string; netMinor?: string }) => {
    const now = new Date()
    await prisma.withTenant(tenantId, async t => {
      const request = await recordAmendmentRequest(t, { tenantId, bookingId, userId, raw: proposal, now })
      await transitionBooking(t, { tenantId, bookingId, action: 'requestAmendment', expectedStatus: 'CONFIRMED', actor: { type: 'USER', id: userId }, level: 'OPERATOR', now, reason: 'guest asked', idempotencyKey: `amend-req:${bookingId}:${JSON.stringify(proposal)}`, eventPayload: request?.eventPayload, fingerprintExtra: `amendment:${JSON.stringify(proposal)}` })
    })
    const charged = (await prisma.ledgerEntry.count({ where: { walletId, reference: `booking:${bookingId}` } })) > 0
    return prisma.withTenant(tenantId, async t => {
      const decision = await prepareAmendmentDecision(t, { tenantId, bookingId, kind: 'APPROVE', rawApproval: approval, ledgerCharged: charged, now })
      await transitionBooking(t, { tenantId, bookingId, action: 'approveAmendment', expectedStatus: 'AMEND_REQUESTED', actor: { type: 'USER', id: userId }, level: 'OPERATOR', now, idempotencyKey: `amend-ok:${bookingId}`, eventPayload: decision?.eventPayload, fingerprintExtra: `approval:${JSON.stringify(approval)}` })
      return decision ? applyAmendmentDecision(t, { tenantId, bookingId, userId, decision, now }) : null
    })
  }

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} h`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'R', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'RO', name: 'Room only' } })).id
    hotelMappingId = (await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${suffix}-sh`, status: 'MAPPED' } })).id
    roomMappingId = (await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: hotelMappingId, hotelId, supplierRoomId: `${suffix}-sr`, roomTypeId: roomId, status: 'MAPPED' } })).id
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: hotelMappingId, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: suffix, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: 3, penaltyPercent: 100 } })
    await prisma.dailyAvailability.createMany({ data: ['2099-03-01', '2099-03-02', '2099-03-03', '2099-03-04'].map(d => ({ tenantId, ratePlanId, stayDate: new Date(d), allotment: 5 })) })
    walletId = (await makeAgencyBooker(prisma, tenantId, userId, 100_000_000n)).walletId
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await eraseLedger(prisma, { where: { tenantId } })
    await prisma.supplierMutation.deleteMany({ where: { tenantId } })
    await prisma.bookingDocument.deleteMany({ where: { tenantId } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await removeAgencyBookers(prisma, tenantId)
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId } })
    await prisma.cancellationPolicy.deleteMany({ where: { contractId } })
    await prisma.ratePlan.delete({ where: { id: ratePlanId } })
    await prisma.contract.delete({ where: { id: contractId } })
    await prisma.supplierRoomMapping.delete({ where: { id: roomMappingId } })
    await prisma.supplierHotelMapping.delete({ where: { id: hotelMappingId } })
    await prisma.boardBasis.delete({ where: { id: boardId } })
    await prisma.roomType.delete({ where: { id: roomId } })
    await prisma.hotel.delete({ where: { id: hotelId } })
    await prisma.supplier.delete({ where: { id: supplierId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('LIFE-01 walks recheck -> hold -> prebook -> confirm -> documents -> cancel -> credit note, replaying every step with no second effect', async () => {
    await resetInventory(5)
    const key = `${suffix}-walk`
    const net0 = await walletNet()

    // recheck allocates nothing
    recheckResult = { status: 'available', offer: offerFor(key) }
    const rechecked = await offerHolds.recheck({ offerId: `offer-${key}`, searchId: `search-${key}`, expectedCurrency: 'AED', expectedSellAmountMinor: price, tenantId, requestId: `${key}-rc`, user: actor() })
    expect(rechecked.status).toBe('rechecked')
    expect((await grid()).every(n => n.held === 0 && n.sold === 0)).toBe(true)

    // hold: replay returns the same hold, inventory moves once
    const held = await holdOffer(key)
    expect(held.status).toBe('held')
    expect((await holdOffer(key)).holdId).toBe(held.holdId)
    expect((await grid()).slice(0, 2).map(n => n.held)).toEqual([1, 1])

    // prebook: replay returns the same booking; one reservation on the ledger
    const pre = await prebook(key, held.holdId!)
    expect(pre.status).toBe('prebooked')
    expect((await prebook(key, held.holdId!)).bookingId).toBe(pre.bookingId)
    expect(await prisma.booking.count({ where: { tenantId, idempotencyKey: key } })).toBe(1)
    expect(await ledgerTypes(pre.bookingId)).toEqual([{ type: 'HOLD', amountMinor: -BigInt(price) }])

    // no voucher before confirmation
    await expect(doc(pre.bookingId, 'VOUCHER')).rejects.toThrow('confirmed booking')

    // confirm: held -> sold, reservation -> debit, replay is a no-op
    const first = await confirm(pre.bookingId)
    expect(first).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: false })
    expect(await confirm(pre.bookingId)).toMatchObject({ alreadyConfirmed: true })
    expect((await grid()).slice(0, 2).map(n => [n.held, n.sold])).toEqual([[0, 1], [0, 1]])
    expect((await ledgerTypes(pre.bookingId)).map(e => e.type)).toEqual(['HOLD', 'RELEASE', 'DEBIT'])
    expect(await walletNet()).toBe(net0 - BigInt(price))
    const events = await prisma.bookingEvent.findMany({ where: { bookingId: pre.bookingId }, orderBy: { createdAt: 'asc' }, select: { action: true, toStatus: true } })
    expect(events.map(e => e.toStatus)).toContain('CONFIRMED')
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'booking.confirmed', entityId: pre.bookingId } })).toBe(1)

    // voucher and invoice: issued once, frozen, replay returns the same number
    const voucher = await doc(pre.bookingId, 'VOUCHER')
    expect(voucher).toMatchObject({ alreadyIssued: false, number: `VCH-${first.reference}` })
    expect(voucher.payload.stay).toMatchObject(stay)
    expect(await doc(pre.bookingId, 'VOUCHER')).toMatchObject({ alreadyIssued: true, id: voucher.id })
    await expect(doc(pre.bookingId, 'CREDIT_NOTE')).rejects.toThrow('cancelled booking')
    await doc(pre.bookingId, 'INVOICE')

    // cancel: inventory returned, refund posted once, replay is a no-op
    const done = await cancel(pre.bookingId)
    expect(done).toMatchObject({ status: 'CANCELLED', alreadyCancelled: false, penaltyMinor: '0', refundMinor: String(price) })
    expect(await cancel(pre.bookingId)).toMatchObject({ alreadyCancelled: true, cancellationId: done.cancellationId })
    expect((await grid()).slice(0, 2).map(n => [n.held, n.sold])).toEqual([[0, 0], [0, 0]])
    expect((await ledgerTypes(pre.bookingId)).map(e => e.type)).toEqual(['HOLD', 'RELEASE', 'DEBIT', 'REFUND'])
    expect(await walletNet()).toBe(net0)
    expect(await prisma.inventoryHold.findUniqueOrThrow({ where: { id: held.holdId! } })).toMatchObject({ status: 'RELEASED' })
    // documents are immutable: the voucher still reads as issued, and a credit note now exists
    expect(await doc(pre.bookingId, 'VOUCHER')).toMatchObject({ id: voucher.id, bookingStatus: 'CANCELLED' })
    expect(await doc(pre.bookingId, 'CREDIT_NOTE')).toMatchObject({ number: `CN-${first.reference}` })
    // cancelled is terminal for the agent flow
    await expect(confirm(pre.bookingId)).rejects.toThrow()
    await expect(cancellations.quote({ tenantId, userId, requestId: 'q', bookingId: pre.bookingId })).rejects.toThrow('not cancellable')
  })

  it('LIFE-02 recheck outcomes that must never create a hold or a booking', async () => {
    await resetInventory(5)
    const before = await grid()
    const key = `${suffix}-refuse`
    const priceChanged = await holdOffer(key, `${key}-a`, price + 100)
    expect(priceChanged.status).toBe('price_changed')
    recheckResult = { status: 'unavailable' }
    expect((await offerHolds.execute({ offerId: 'x', searchId: 'y', expectedCurrency: 'AED', expectedSellAmountMinor: price, idempotencyKey: `${key}-b`, tenantId, requestId: `${key}-b`, user: actor() })).status).toBe('unavailable')
    recheckResult = { status: 'available', offer: offerFor(`${key}-c`, { sellAmountMinor: price }) }
    const expired = { ...offerFor(`${key}-e`), expiresAt: new Date(Date.now() - 1000).toISOString() }
    recheckResult = { status: 'available', offer: expired }
    expect((await offerHolds.execute({ offerId: expired.offerId, searchId: expired.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: price, idempotencyKey: `${key}-e`, tenantId, requestId: `${key}-e`, user: actor() })).status).toBe('offer_expired')
    expect(await grid()).toEqual(before)
    expect(await prisma.inventoryHold.count({ where: { tenantId, idempotencyKey: { startsWith: key } } })).toBe(0)
  })

  it('LIFE-03 reuse of an idempotency key with a different commercial request is refused, not replayed', async () => {
    await resetInventory(5)
    const key = `${suffix}-reuse`
    const first = await holdOffer(key)
    expect(first.status).toBe('held')
    recheckResult = { status: 'available', offer: offerFor(`${key}-other`, { checkOut: '2099-03-04' }) }
    const clash = await offerHolds.execute({ offerId: `offer-${key}-other`, searchId: `search-${key}-other`, expectedCurrency: 'AED', expectedSellAmountMinor: price, idempotencyKey: key, tenantId, requestId: `${key}-clash`, user: actor() })
    expect(clash.status).toBe('unavailable')
    expect((await grid()).map(n => n.held)).toEqual([1, 1, 0, 0])
  })

  it('LIFE-04 ten agents race for the last room: one hold, nine refusals, inventory never negative', async () => {
    await resetInventory(1)
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => holdOffer(`${suffix}-race-${i}`)))
    expect(results.filter(r => r.status === 'held')).toHaveLength(1)
    expect(results.filter(r => r.status === 'unavailable')).toHaveLength(9)
    const rows = await grid()
    for (const n of rows) expect(n.allotment - n.sold - n.held).toBeGreaterThanOrEqual(0)
    expect(rows.slice(0, 2).map(n => n.held)).toEqual([1, 1])
  })

  it('LIFE-05 25 concurrent confirmations and 25 concurrent cancellations each produce exactly one sale / one refund', async () => {
    await resetInventory(5)
    const key = `${suffix}-converge`
    const net0 = await walletNet()
    const held = await holdOffer(key)
    const pre = await prebook(key, held.holdId!)
    const confirmations = await Promise.allSettled(Array.from({ length: 25 }, () => confirm(pre.bookingId)))
    expect(confirmations.every(r => r.status === 'fulfilled')).toBe(true)
    expect((await grid()).slice(0, 2).map(n => n.sold)).toEqual([1, 1])
    expect((await ledgerTypes(pre.bookingId)).map(e => e.type)).toEqual(['HOLD', 'RELEASE', 'DEBIT'])
    const cancellationsRun = await Promise.allSettled(Array.from({ length: 25 }, () => cancel(pre.bookingId)))
    expect(cancellationsRun.every(r => r.status === 'fulfilled')).toBe(true)
    expect(new Set(cancellationsRun.map(r => (r as PromiseFulfilledResult<{ cancellationId: string }>).value.cancellationId)).size).toBe(1)
    expect((await ledgerTypes(pre.bookingId)).map(e => e.type)).toEqual(['HOLD', 'RELEASE', 'DEBIT', 'REFUND'])
    expect(await walletNet()).toBe(net0)
    expect((await grid()).slice(0, 2).map(n => n.sold)).toEqual([0, 0])
  })

  it('LIFE-06 a confirm racing a cancel of the same booking never leaves a sold room behind or an unrefunded charge', async () => {
    await resetInventory(5)
    const key = `${suffix}-confirm-vs-cancel`
    const net0 = await walletNet()
    const held = await holdOffer(key)
    const pre = await prebook(key, held.holdId!)
    // cancel needs CONFIRMED, so before confirm it must refuse; the race is confirm vs an eager cancel
    const [c, k] = await Promise.allSettled([confirm(pre.bookingId), cancel(pre.bookingId)])
    expect(c.status).toBe('fulfilled')
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: pre.bookingId } })
    const rows = (await grid()).slice(0, 2)
    if (k.status === 'fulfilled') {
      expect(booking.status).toBe('CANCELLED')
      expect(rows.map(n => [n.held, n.sold])).toEqual([[0, 0], [0, 0]])
      expect(await walletNet()).toBe(net0)
    } else {
      expect(booking.status).toBe('CONFIRMED')
      expect(rows.map(n => [n.held, n.sold])).toEqual([[0, 1], [0, 1]])
      expect(await walletNet()).toBe(net0 - BigInt(price))
    }
  })

  it('LIFE-07 amendment: a stay or occupancy change on an inventory-backed booking is refused at the request, changes nothing and leaves the booking cancellable', async () => {
    await resetInventory(5)
    const { bookingId } = await bookedThrough(`${suffix}-amend`)
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })
    expect(before).toMatchObject({ status: 'CONFIRMED', version: 1, nights: 2 })
    const gridBefore = await grid()
    const refused = (proposal: object) => expect(amend(bookingId, proposal, { sellMinor: String(price) })).rejects.toMatchObject({ response: { code: 'AMENDMENT_INVENTORY_BACKED' } })
    await refused({ checkOut: '2099-03-04' })
    await refused({ rooms: [{ position: 1, adults: 1, children: 0, childAges: [] }] })
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({ status: 'CONFIRMED', version: 1, nights: 2, totalMinor: BigInt(price) })
    expect(await prisma.bookingAmendment.count({ where: { bookingId } })).toBe(0)
    expect(await grid()).toEqual(gridBefore)
    // the guest is still served: voucher shows the real stay and the booking cancels cleanly
    expect((await doc(bookingId, 'VOUCHER')).payload.stay).toMatchObject(stay)
    expect(await cancel(bookingId)).toMatchObject({ status: 'CANCELLED' })
    expect((await grid()).map(n => n.sold)).toEqual([0, 0, 0, 0])
  })

  it('LIFE-08 a request opened before the guard existed cannot be approved either, and rejecting it restores a cancellable booking', async () => {
    await resetInventory(5)
    const { bookingId } = await bookedThrough(`${suffix}-legacy`)
    const now = new Date()
    // simulate a pre-guard open request: the row and the status move are written directly
    await prisma.bookingAmendment.create({ data: { tenantId, bookingId, fromVersion: 1, proposal: { checkOut: '2099-03-04' }, beforeState: {}, requestedByUserId: userId } })
    await prisma.withTenant(tenantId, t => transitionBooking(t, { tenantId, bookingId, action: 'requestAmendment', expectedStatus: 'CONFIRMED', actor: { type: 'USER', id: userId }, level: 'OPERATOR', now, reason: 'legacy', idempotencyKey: `legacy:${bookingId}` }))
    await expect(prisma.withTenant(tenantId, t => prepareAmendmentDecision(t, { tenantId, bookingId, kind: 'APPROVE', rawApproval: { sellMinor: String(price) }, ledgerCharged: true, now })))
      .rejects.toMatchObject({ response: { code: 'AMENDMENT_INVENTORY_BACKED' } })
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({ status: 'AMEND_REQUESTED', nights: 2 })
    await prisma.withTenant(tenantId, async t => {
      const decision = await prepareAmendmentDecision(t, { tenantId, bookingId, kind: 'REJECT', rawApproval: undefined, ledgerCharged: null, now })
      await transitionBooking(t, { tenantId, bookingId, action: 'rejectAmendment', expectedStatus: 'AMEND_REQUESTED', actor: { type: 'USER', id: userId }, level: 'OPERATOR', now, reason: 'cannot re-allocate', idempotencyKey: `legacy-reject:${bookingId}`, eventPayload: decision?.eventPayload })
      await applyAmendmentDecision(t, { tenantId, bookingId, userId, decision: decision!, now })
    })
    expect(await cancel(bookingId)).toMatchObject({ status: 'CANCELLED' })
  })
})
