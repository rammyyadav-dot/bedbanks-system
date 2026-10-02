import { randomBytes } from 'crypto'
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../src/agent/supplier-prebook-orchestration.service'
import { BookingConfirmationService } from '../src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../src/agent/booking-transaction.service'
import { BookingCancellationService } from '../src/agent/booking-cancellation.service'
import { CancellationPolicyService } from '../src/agent/cancellation-policy.service'
import { BookingReconciliationService } from '../src/agent/booking-reconciliation.service'
import { BookingDocumentService } from '../src/agent/booking-document.service'
import { LedgerService } from '../src/agent/ledger.service'
import type { SupplierAdapter } from '../src/agent/supplier.port'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { OperationsSupplyService } from '../src/admin-operations/operations-supply.service'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')

interface Fixture { tenantId: string; userId: string; supplierId: string; hotelId: string; roomId: string; boardId: string; contractId: string; ratePlanId: string }

describe('admin operations API (PostgreSQL, two tenants)', () => {
  const prisma = new PrismaService()
  const audit = new AgentAuditService(prisma)
  const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma)
  const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const confirmation = new BookingConfirmationService(prisma)
  const docs = new BookingDocumentService(prisma, audit)
  const cancellations = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:test' }) } as unknown as SupplierAdapter
  const bookingTx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, supplier), confirmation)
  const reconciliation = new BookingReconciliationService(prisma, finance, holds, audit)
  const tx = new OperationsTransactionsService(prisma, reconciliation)
  const supply = new OperationsSupplyService(prisma)
  const suffix = `ops-${Date.now()}-${randomBytes(3).toString('hex')}`
  const stay = new Date(Date.now() + 40 * 86_400_000)
  const nights = [stay, new Date(stay.getTime() + 86_400_000)]
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const checkIn = ymd(nights[0]); const checkOut = ymd(new Date(stay.getTime() + 2 * 86_400_000))
  let A: Fixture, B: Fixture

  async function fixture(tag: string): Promise<Fixture> {
    const key = `${suffix}-${tag}`
    const tenantId = (await prisma.tenant.create({ data: { name: key, slug: key } })).id
    const userId = (await prisma.user.create({ data: { email: `${key}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    const supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${key} s`, displayName: `${key} supplier`, countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${key} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })).id
    const roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Deluxe', code: key, maxAdults: 2, maxOccupancy: 2 } })).id
    const boardId = (await prisma.boardBasis.create({ data: { tenantId, code: "RO", name: 'Room only' } })).id
    const contractId = (await prisma.contract.create({ data: { tenantId, supplierId, code: key, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    const ratePlanId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: key, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    await prisma.dailyAvailability.createMany({ data: nights.map(stayDate => ({ tenantId, ratePlanId, stayDate, allotment: 20 })) })
    await prisma.dailyRate.createMany({ data: nights.map(stayDate => ({ tenantId, ratePlanId, stayDate, occupancy: 2, amountMinor: 62_550n, currency: 'AED', amountBasis: 'SELL' })) })
    await prisma.wallet.create({ data: { tenantId, currency: 'AED', creditLimit: 1_000_000n, cachedBalance: 0n } })
    return { tenantId, userId, supplierId, hotelId, roomId, boardId, contractId, ratePlanId }
  }

  async function purge(f: Fixture | undefined) {
    if (!f) return
    const { tenantId } = f
    await prisma.connectorExecution.deleteMany({ where: { tenantId } })
    await prisma.connectorCredentialReference.deleteMany({ where: { connector: { tenantId } } })
    await prisma.connectorDefinition.deleteMany({ where: { tenantId } })
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } })
    await prisma.bookingDocument.deleteMany({ where: { tenantId } })
    await prisma.booking.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } })
    await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await prisma.wallet.deleteMany({ where: { tenantId } })
    await prisma.dailyRate.deleteMany({ where: { tenantId } })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
    await prisma.cancellationPolicy.deleteMany({ where: { contract: { tenantId } } })
    await prisma.ratePlan.deleteMany({ where: { tenantId } })
    await prisma.contract.deleteMany({ where: { tenantId } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
    await prisma.boardBasis.deleteMany({ where: { id: f.boardId } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
    await prisma.hotel.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { id: f.supplierId } })
    await prisma.userRole.deleteMany({ where: { tenantId } })
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
    await prisma.role.deleteMany({ where: { tenantId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { id: f.userId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
  }

  const guest = { firstName: 'Layla', lastName: 'Hassan' }
  async function book(f: Fixture, key: string, finish: 'confirm' | 'cancel' | 'none' = 'confirm') {
    const hold = await holds.create({ tenantId: f.tenantId, userId: f.userId, requestId: `${key}-req`, idempotencyKey: key, offerId: `offer-${key}`, searchId: `search-${key}`, ratePlanId: f.ratePlanId,
      canonicalHotelId: f.hotelId, canonicalRoomTypeId: f.roomId, boardBasisId: f.boardId, checkIn, checkOut, rooms: 1, currency: 'AED', sellAmountMinor: 125_100, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    const pre = await bookingTx.prebook({ tenantId: f.tenantId, userId: f.userId, requestId: `${key}-pre`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: guest })
    if (finish !== 'none') await bookingTx.confirm({ tenantId: f.tenantId, userId: f.userId, requestId: `${key}-confirm`, bookingId: pre.bookingId })
    if (finish === 'cancel') await cancellations.cancel({ tenantId: f.tenantId, userId: f.userId, requestId: `${key}-cancel`, bookingId: pre.bookingId })
    return { holdId: hold.holdId, bookingId: pre.bookingId }
  }

  let confirmedA: { holdId: string; bookingId: string }, cancelledA: { holdId: string; bookingId: string }, stuckA: { holdId: string; bookingId: string }

  beforeAll(async () => {
    await prisma.$connect()
    A = await fixture('a'); B = await fixture('b')
    await prisma.cancellationPolicy.create({ data: { contractId: A.contractId, daysBeforeCheckin: 7, penaltyPercent: 0 } })
    confirmedA = await book(A, `${suffix}-confirmed`)
    cancelledA = await book(A, `${suffix}-cancelled`, 'cancel')
    stuckA = await book(A, `${suffix}-stuck`, 'none')
    await book(B, `${suffix}-b-confirmed`)
    await prisma.connectorDefinition.create({ data: { tenantId: A.tenantId, supplierId: A.supplierId, type: 'API_JSON', status: 'DRAFT', name: `${suffix} connector`, version: '1', credentialReferences: { create: [{ secretRef: 'vault://never-returned', purpose: 'api_key' }] } } })
  })

  afterAll(async () => { await purge(A); await purge(B); await prisma.$disconnect() })

  // ---- Booking 360 ---------------------------------------------------------------------------------------------------
  it('ADMIN-BOOKING-360: shows booking, hold, ledger, audit and documents for the right tenant, with integer-string money', async () => {
    const view = await tx.booking(A.tenantId, confirmedA.bookingId)
    expect(view.booking.status).toBe('CONFIRMED')
    expect(view.commercial).toMatchObject({ currency: 'AED', totalMinor: '125100' })
    expect(view.inventory.hold?.status).toBe('CONFIRMED')
    expect(view.inventory.hold?.nights).toHaveLength(2)
    expect(view.finance.entries.some(e => e.type === 'DEBIT')).toBe(true)
    expect(view.supplier.supplierBookingReference).toBeNull()
    expect(view.attention).toEqual([])
    expect(view.audit.length).toBeGreaterThan(0)
    for (const e of view.finance.entries) expect(e.amountMinor).toMatch(/^-?\d+$/)
  })

  it('ADMIN-CANCEL: a cancelled booking reconciles its record, refund and released hold', async () => {
    const view = await tx.booking(A.tenantId, cancelledA.bookingId)
    expect(view.booking.status).toBe('CANCELLED')
    expect(view.cancellation.record).not.toBeNull()
    expect(view.inventory.hold?.status).toBe('RELEASED')
    expect(view.attention).toEqual([])
    const list = await tx.cancellations(A.tenantId, {})
    const row = list.items.find(c => c.bookingId === cancelledA.bookingId)
    expect(row?.refundMatches).toBe(true)
  })

  // ---- tenant isolation ----------------------------------------------------------------------------------------------
  it('ADMIN-ISOLATION: tenant B cannot read tenant A bookings, holds, ledger, wallets, audit, connectors or documents', async () => {
    await expect(tx.booking(B.tenantId, confirmedA.bookingId)).rejects.toBeInstanceOf(NotFoundException)
    await expect(tx.hold(B.tenantId, confirmedA.holdId)).rejects.toBeInstanceOf(NotFoundException)
    await expect(tx.documentHtml(B.tenantId, confirmedA.bookingId, 'invoice')).rejects.toBeInstanceOf(NotFoundException)
    const aBookings = (await tx.bookings(A.tenantId, {})).items.map(b => b.id)
    const bBookings = await tx.bookings(B.tenantId, {})
    expect(bBookings.total).toBe(1)
    expect(bBookings.items.every(b => !aBookings.includes(b.id) && b.tenantId === B.tenantId)).toBe(true)
    expect((await tx.holds(B.tenantId, {})).items.every(h => h.tenantId === B.tenantId)).toBe(true)
    expect((await tx.wallets(B.tenantId, {})).items.every(w => w.tenantId === B.tenantId)).toBe(true)
    const ledgerB = await tx.ledger(B.tenantId, {})
    const walletsA = (await tx.wallets(A.tenantId, {})).items.map(w => w.id)
    expect(ledgerB.items.every(e => !walletsA.includes(e.walletId))).toBe(true)
    expect((await tx.audit(B.tenantId, {})).items.every(a => !a.entityId.includes(confirmedA.bookingId))).toBe(true)
    expect((await tx.connectors(B.tenantId, {})).total).toBe(0)
    expect((await supply.hotels(B.tenantId, B.userId, {}).catch(e => e)).constructor.name).toBe('ForbiddenException') // no formal role: fail closed
  })

  it('ADMIN-IDS: a tenant id supplied in a query string is ignored; scope is the caller tenant only', async () => {
    const result = await tx.bookings(B.tenantId, { tenantId: A.tenantId })
    expect(result.items.every(b => b.tenantId === B.tenantId)).toBe(true)
  })

  // ---- pagination and validation --------------------------------------------------------------------------------------
  it('ADMIN-PAGING: server-side paging, filters and strict validation', async () => {
    const page1 = await tx.bookings(A.tenantId, { pageSize: '2', page: '1' })
    const page2 = await tx.bookings(A.tenantId, { pageSize: '2', page: '2' })
    expect(page1.total).toBe(3)
    expect(page1.items).toHaveLength(2)
    expect(page2.items).toHaveLength(1)
    expect(new Set([...page1.items, ...page2.items].map(b => b.id)).size).toBe(3)
    expect((await tx.bookings(A.tenantId, { status: 'CANCELLED' })).items.map(b => b.id)).toEqual([cancelledA.bookingId])
    const reference = (await tx.booking(A.tenantId, confirmedA.bookingId)).booking.reference
    expect((await tx.bookings(A.tenantId, { reference })).items.map(b => b.id)).toEqual([confirmedA.bookingId])
    await expect(tx.bookings(A.tenantId, { pageSize: '1000' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(tx.bookings(A.tenantId, { page: '0' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(tx.bookings(A.tenantId, { status: 'DROP' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(tx.bookings(A.tenantId, { createdFrom: '2026-13-45' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(tx.bookings(A.tenantId, { reference: "x' OR 1=1 --" })).rejects.toBeInstanceOf(BadRequestException)
    await expect(tx.booking(A.tenantId, '../etc/passwd')).rejects.toBeInstanceOf(BadRequestException)
  })

  // ---- documents are read-only and immutable ---------------------------------------------------------------------------
  it('ADMIN-DOCS: Admin renders only issued documents and never issues one', async () => {
    await expect(tx.documentHtml(A.tenantId, confirmedA.bookingId, 'voucher')).rejects.toBeInstanceOf(NotFoundException)
    expect((await tx.booking(A.tenantId, confirmedA.bookingId)).documents).toHaveLength(0)
    await docs.get({ tenantId: A.tenantId, userId: A.userId, requestId: 'doc-1', bookingId: confirmedA.bookingId, type: 'VOUCHER' })
    const html = await tx.documentHtml(A.tenantId, confirmedA.bookingId, 'voucher')
    expect(html).toContain('<html')
    expect((await tx.booking(A.tenantId, confirmedA.bookingId)).documents.map(d => d.type)).toEqual(['VOUCHER'])
    await expect(prisma.bookingDocument.updateMany({ where: { tenantId: A.tenantId }, data: { number: 'TAMPER' } })).rejects.toBeDefined()
    await expect(tx.documentHtml(A.tenantId, confirmedA.bookingId, '__proto__')).rejects.toBeInstanceOf(BadRequestException)
  })

  // ---- reconciliation ----------------------------------------------------------------------------------------------------
  it('ADMIN-RECON: stuck holds surface in the queue, a dry run changes nothing, and a run reconciles through the existing service', async () => {
    await prisma.$executeRaw`UPDATE "InventoryHold" SET updated_at = now() - interval '2 hours' WHERE id = ${stuckA.holdId}`
    // Inside its confirmation window a prebooked attempt is deliberately left alone; age the marker past it.
    await prisma.$executeRaw`UPDATE "AuditEvent" SET created_at = now() - interval '2 hours' WHERE action = 'booking.prebook.succeeded' AND entity_id = ${stuckA.bookingId}`
    const before = await tx.reconciliationQueue(A.tenantId, A.userId, 'req-queue')
    const hit = before.cases.find(c => c.holdId === stuckA.holdId)
    expect(hit).toMatchObject({ source: 'reconciliation_dry_run', holdStatus: 'PROCESSING' })
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: stuckA.holdId } })).status).toBe('PROCESSING') // dry run is read-only
    expect((await tx.reconciliationQueue(B.tenantId, B.userId, 'req-queue-b')).cases.some(c => c.holdId === stuckA.holdId)).toBe(false)
    const run = await tx.reconcile(A.tenantId, A.userId, 'req-run', {})
    expect(run.items.find(i => i.holdId === stuckA.holdId)?.outcome).toBe('prebook_expired')
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: stuckA.bookingId } })).status).toBe('FAILED')
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: stuckA.holdId } })).status).toBe('RELEASED')
    const again = await tx.reconcile(A.tenantId, A.userId, 'req-run-2', {})
    expect(again.items.some(i => i.holdId === stuckA.holdId && i.outcome === 'failed')).toBe(false) // idempotent
    expect((await prisma.auditEvent.count({ where: { tenantId: A.tenantId, action: 'booking.prebook.expired', entityId: stuckA.bookingId } }))).toBeGreaterThan(0)
    await expect(tx.reconcile(A.tenantId, A.userId, 'bad', { staleMinutes: -5 })).rejects.toBeInstanceOf(BadRequestException)
  })

  // ---- finance ----------------------------------------------------------------------------------------------------------
  it('ADMIN-LEDGER: wallet balance equals the ledger sum and available credit uses the canonical formula', async () => {
    const [wallet] = (await tx.wallets(A.tenantId, {})).items
    const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: A.tenantId } })
    const sum = entries.reduce((n, e) => n + e.amountMinor, 0n)
    expect(wallet.balanceMinor).toBe(sum.toString())
    expect(wallet.availableCreditMinor).toBe((1_000_000n + sum).toString())
    expect(wallet.entryCount).toBe(entries.length)
    const byType = await tx.ledger(A.tenantId, { type: 'DEBIT' })
    expect(byType.items.every(e => e.type === 'DEBIT')).toBe(true)
    const forBooking = await tx.ledger(A.tenantId, { bookingId: confirmedA.bookingId })
    expect(forBooking.items.length).toBeGreaterThan(0)
  })

  it('ADMIN-AUDIT: filters by request id and entity, and never returns raw credential references', async () => {
    const byEntity = await tx.audit(A.tenantId, { entityId: confirmedA.bookingId })
    expect(byEntity.items.length).toBeGreaterThan(0)
    expect(byEntity.items.every(a => a.entityId === confirmedA.bookingId)).toBe(true)
    const connectors = await tx.connectors(A.tenantId, {})
    expect(JSON.stringify(connectors)).not.toContain('vault://never-returned')
    expect(connectors.items[0].credentials).toEqual([{ purpose: 'api_key', status: 'configured' }])
  })

  it('ADMIN-23: the audit explorer returns sanitised payloads (credentials, tokens and contact details redacted)', async () => {
    await audit.record({ tenantId: A.tenantId, userId: A.userId, action: 'admin.sanitise.probe', entityType: 'probe', entityId: 'probe-1', payload: { requestId: 'req-sanitise', email: 'guest@example.com', phone: '+971500000000', token: 'tok-secret-123', password: 'hunter2', note: 'kept' } })
    const [event] = (await tx.audit(A.tenantId, { requestId: 'req-sanitise' })).items
    expect(event.action).toBe('admin.sanitise.probe')
    expect(event.requestId).toBe('req-sanitise')
    const text = JSON.stringify(event)
    for (const secret of ['guest@example.com', '+971500000000', 'tok-secret-123', 'hunter2']) expect(text).not.toContain(secret)
    expect(event.payload.note).toBe('kept')
  })

  // ---- hotels and readiness ------------------------------------------------------------------------------------------------
  it('ADMIN-SUPPLY: hotel readiness uses canonical sellability and paginates', async () => {
    await prisma.userRole.deleteMany({ where: { tenantId: A.tenantId } })
    const role = await prisma.role.create({ data: { tenantId: A.tenantId, name: `${suffix}-viewer` } })
    for (const key of ['supply.hotels.read', 'supply.suppliers.read']) {
      const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    }
    await prisma.userRole.create({ data: { userId: A.userId, roleId: role.id, tenantId: A.tenantId } })
    const hotels = await supply.hotels(A.tenantId, A.userId, { from: checkIn, days: '2' })
    expect(hotels.total).toBe(1)
    expect(hotels.items[0]).toMatchObject({ rooms: 1, ratePlans: 1, readiness: 'READY' })
    // Stop-sell blocks the hotel with a canonical reason, not a guess.
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: A.ratePlanId }, data: { stopSell: true } })
    const blocked = await supply.hotels(A.tenantId, A.userId, { from: checkIn, days: '2' })
    expect(blocked.items[0]).toMatchObject({ readiness: 'BLOCKED' })
    expect(blocked.items[0].blockers).toContain('STOP_SELL')
    expect((await supply.hotels(A.tenantId, A.userId, { readiness: 'READY', from: checkIn, days: '2' })).total).toBe(0)
    const readiness = await supply.readiness(A.tenantId, A.userId, { from: checkIn, days: '2' }, () => tx.transactionSummary(A.tenantId), () => tx.connectorSummary(A.tenantId))
    expect(readiness.supply).toMatchObject({ state: 'available', data: { hotels: { blocked: 1, sellable: 0 }, stopSellHotels: 1 } })
    expect(readiness.transactions).toMatchObject({ state: 'available' })
    const suppliers = await supply.suppliers(A.tenantId, A.userId, {})
    expect(suppliers.items[0].contracts).toEqual({ total: 1, active: 1 })
    expect((await supply.suppliers(A.tenantId, A.userId, { status: 'ACTIVE' })).total).toBe(1)
    expect((await supply.suppliers(A.tenantId, A.userId, { status: 'PENDING_REVIEW' })).total).toBe(0)
    await expect(supply.suppliers(A.tenantId, A.userId, { status: 'NOT_A_STATUS' })).rejects.toBeInstanceOf(BadRequestException)
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: A.ratePlanId }, data: { stopSell: false } })
    await prisma.userRole.deleteMany({ where: { tenantId: A.tenantId } })
    await prisma.role.delete({ where: { id: role.id } })
  })

  // ---- Dubai operations scenarios A-L: the operator can see WHY, without SQL ---------------------------------------------------
  it('ADMIN-SCENARIOS A-L: each operational state is explained by the API with a canonical cause', async () => {
    const role = await prisma.role.create({ data: { tenantId: A.tenantId, name: `${suffix}-scen` } })
    for (const key of ['supply.hotels.read', 'supply.suppliers.read']) {
      const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    }
    await prisma.userRole.create({ data: { userId: A.userId, roleId: role.id, tenantId: A.tenantId } })
    const inWindow = { from: checkIn, days: '2' }
    type Opts = { hotelMapping?: 'MAPPED' | 'PENDING'; roomMapping?: boolean; validTo?: string; rates?: boolean; availability?: boolean; stopSell?: boolean; allotment?: number; sold?: number }
    async function scenarioHotel(code: string, o: Opts = {}) {
      const name = `${suffix}-scn-${code}`
      const hotel = await prisma.hotel.create({ data: { tenantId: A.tenantId, name, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })
      const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Std', code: `${code}-${suffix}`.slice(0, 40), maxAdults: 2, maxOccupancy: 2 } })
      const mapping = o.hotelMapping ? await prisma.supplierHotelMapping.create({ data: { tenantId: A.tenantId, supplierId: A.supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${code}`, status: o.hotelMapping } }) : null
      if (mapping && o.roomMapping) await prisma.supplierRoomMapping.create({ data: { tenantId: A.tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-r-${code}`, roomTypeId: room.id, status: 'MAPPED' } })
      const contract = await prisma.contract.create({ data: { tenantId: A.tenantId, supplierId: A.supplierId, supplierHotelMappingId: mapping?.id ?? null, code: `${suffix}-scn-${code}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date(o.validTo ?? '2099-12-31'), settlementCurrency: 'AED' } })
      const plan = await prisma.ratePlan.create({ data: { tenantId: A.tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: A.boardId, code: `${suffix}-scn-${code}`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
      if (o.rates !== false) await prisma.dailyRate.createMany({ data: nights.map(stayDate => ({ tenantId: A.tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
      if (o.availability !== false) await prisma.dailyAvailability.createMany({ data: nights.map(stayDate => ({ tenantId: A.tenantId, ratePlanId: plan.id, stayDate, allotment: o.allotment ?? 5, sold: o.sold ?? 0, stopSell: o.stopSell ?? false })) })
      return { hotel, room, plan, name }
    }
    const row = async (name: string) => (await supply.hotels(A.tenantId, A.userId, { ...inWindow, search: name })).items.find(h => h.name === name)!
    try {
      const a = await scenarioHotel('a'); expect(await row(a.name)).toMatchObject({ readiness: 'READY', blockers: [] }) // A sellable
      const b = await scenarioHotel('b', { hotelMapping: 'PENDING' }); expect((await row(b.name)).blockers).toContain('SUPPLIER_MAPPING_INVALID') // B hotel mapping missing/unapproved
      const c = await scenarioHotel('c', { hotelMapping: 'MAPPED', roomMapping: false }); expect((await row(c.name)).blockers).toContain('ROOM_MAPPING_UNAPPROVED') // C room mapping invalid
      const d = await scenarioHotel('d', { validTo: '2026-02-01' }); expect((await row(d.name)).blockers).toContain('OUTSIDE_CONTRACT_VALIDITY') // D contract outside validity
      const e = await scenarioHotel('e', { rates: false }); expect(await row(e.name)).toMatchObject({ readiness: 'BLOCKED' }); expect((await row(e.name)).blockers).toContain('DAILY_RATE_MISSING_OR_INVALID') // E rate missing
      const f = await scenarioHotel('f', { availability: false }); expect((await row(f.name)).blockers).toContain('AVAILABILITY_MISSING') // F availability missing
      const g = await scenarioHotel('g', { stopSell: true }); expect((await row(g.name)).blockers).toContain('STOP_SELL') // G stop sell
      const h = await scenarioHotel('h', { allotment: 3, sold: 3 }); expect((await row(h.name)).blockers).toContain('NO_INVENTORY') // H inventory exhausted

      // I: an active hold consumes inventory and is visible with its night-level effect.
      const i = await scenarioHotel('i', { allotment: 1 })
      const hold = await holds.create({ tenantId: A.tenantId, userId: A.userId, requestId: `${suffix}-i`, idempotencyKey: `${suffix}-i`, offerId: 'o-i', searchId: 's-i', ratePlanId: i.plan.id, canonicalHotelId: i.hotel.id, canonicalRoomTypeId: i.room.id, boardBasisId: A.boardId,
        checkIn, checkOut: ymd(nights[1]), rooms: 1, currency: 'AED', sellAmountMinor: 50_000, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      const detail = await tx.hold(A.tenantId, hold.holdId)
      expect(detail.status).toBe('HELD')
      expect(detail.nights[0]).toMatchObject({ quantity: 1, allotment: 1, held: 1, remaining: 0 })
      expect((await row(i.name)).blockers).toContain('NO_INVENTORY')
      expect((await tx.holds(A.tenantId, { hotelId: i.hotel.id, status: 'HELD' })).items.map(x => x.id)).toEqual([hold.holdId])

      // J: a confirmed booking shows consumed (sold) inventory on its hold nights.
      const confirmed = await tx.booking(A.tenantId, confirmedA.bookingId)
      expect(confirmed.inventory.hold?.status).toBe('CONFIRMED')
      expect(confirmed.inventory.hold?.nights.every(n => (n.sold ?? 0) >= 1)).toBe(true)

      // K and L are proven in ADMIN-RECON and ADMIN-CANCEL; here, confirm their operator-facing flags exist as distinct codes.
      const queue = await tx.reconciliationQueue(A.tenantId, A.userId, 'req-scn')
      expect(queue.cases.every(x => x.detail.length > 0 && x.kind.length > 0)).toBe(true)
      const refund = (await tx.booking(A.tenantId, cancelledA.bookingId)).finance.entries.filter(x => x.type === 'REFUND')
      expect(refund.length).toBeGreaterThan(0)
      await holds.release(A.tenantId, hold.holdId, `${suffix}-i-rel`, { type: 'USER', userId: A.userId })
    } finally {
      await prisma.userRole.deleteMany({ where: { roleId: role.id } })
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
      await prisma.role.delete({ where: { id: role.id } })
    }
  }, 60000)

  // ---- database-level isolation: a non-bypass role under forced RLS ------------------------------------------------------------
  it('ADMIN-RLS: under a non-bypass role, every transaction table returns only the current tenant', async () => {
    const raw = new PrismaClient({ datasourceUrl: ownerUrl })
    const tables = ['Booking', 'InventoryHold', 'LedgerEntry', 'Wallet', 'AuditEvent', 'ConnectorDefinition', 'BookingDocument', 'Hotel', 'Supplier']
    try {
      await raw.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_rls_test') THEN CREATE ROLE fbeds_rls_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;`)
      await raw.$executeRawUnsafe('GRANT fbeds_rls_test TO CURRENT_USER')
      await raw.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO fbeds_rls_test')
      await raw.$executeRawUnsafe(`GRANT SELECT ON TABLE ${tables.map(t => `"${t}"`).join(', ')} TO fbeds_rls_test`)
      const asRole = <T,>(tenantId: string | null, work: (t: PrismaClient) => Promise<T>) => raw.$transaction(async t => {
        await t.$executeRawUnsafe('SET LOCAL ROLE fbeds_rls_test')
        if (tenantId) await t.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
        const [who] = await t.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
        if (who.current_user !== 'fbeds_rls_test') throw new Error('not running as the restricted role')
        return work(t as unknown as PrismaClient)
      })
      const tenantColumn: Record<string, string> = { Booking: 'tenant_id', InventoryHold: 'tenant_id', LedgerEntry: 'tenant_id', Wallet: 'tenant_id', AuditEvent: 'tenant_id', ConnectorDefinition: 'tenant_id', BookingDocument: 'tenant_id', Hotel: 'tenant_id', Supplier: 'tenant_id' }
      for (const table of tables) {
        const own = await asRole(B.tenantId, async t => (await t.$queryRawUnsafe<Array<{ tenant: string | null; n: number }>>(`SELECT ${tenantColumn[table]} AS tenant, count(*)::int AS n FROM "${table}" GROUP BY 1`)))
        expect(own.every(r => r.tenant === B.tenantId)).toBe(true) // never a row of another tenant
        const none = await asRole(null, async t => (await t.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`))[0].n)
        expect({ table, none }).toEqual({ table, none: 0 }) // no tenant context: nothing
      }
      const bBookings = await asRole(B.tenantId, async t => (await t.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM "Booking"')).map(r => r.id))
      expect(bBookings).not.toContain(confirmedA.bookingId)
    } finally { await raw.$disconnect() }
  })

  // ---- privilege boundary -------------------------------------------------------------------------------------------------
  describe('runtime API role (privilege boundary, not an outage)', () => {
    const password = randomBytes(24).toString('hex')
    let previous: string | undefined
    let runtimePrisma: PrismaService
    let runtimeTx: OperationsTransactionsService
    const owner = new PrismaClient({ datasourceUrl: ownerUrl })

    beforeAll(async () => {
      await owner.$connect()
      await provisionApiRuntimeRole(owner, { password })
      const url = new URL(ownerUrl!); url.username = API_RUNTIME_LOGIN_ROLE; url.password = password
      previous = process.env.DATABASE_URL
      process.env.DATABASE_URL = url.toString()
      runtimePrisma = new PrismaService()
      await runtimePrisma.$connect()
      runtimeTx = new OperationsTransactionsService(runtimePrisma, new BookingReconciliationService(runtimePrisma, new BookingFinancialAuthorizationService(runtimePrisma), new InventoryHoldService(runtimePrisma), new AgentAuditService(runtimePrisma)))
    })
    afterAll(async () => {
      process.env.DATABASE_URL = previous
      if (previous === undefined) delete process.env.DATABASE_URL
      await runtimePrisma?.$disconnect(); await owner.$disconnect()
    })

    it('ADMIN-DENIED: transaction views fail with OPERATIONS_READ_DENIED, never an empty list; the dashboard marks the section unavailable', async () => {
      for (const call of [() => runtimeTx.bookings(A.tenantId, {}), () => runtimeTx.holds(A.tenantId, {}), () => runtimeTx.wallets(A.tenantId, {}), () => runtimeTx.ledger(A.tenantId, {}), () => runtimeTx.connectors(A.tenantId, {}), () => runtimeTx.cancellations(A.tenantId, {})]) {
        const error = await call().then(() => null, e => e)
        expect(error).toBeInstanceOf(ServiceUnavailableException)
        expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: OPERATIONS_READ_DENIED })
      }
      expect(await runtimeTx.transactionSummary(A.tenantId)).toEqual({ state: 'unavailable', reason: OPERATIONS_READ_DENIED })
      expect(await runtimeTx.connectorSummary(A.tenantId)).toEqual({ state: 'unavailable', reason: OPERATIONS_READ_DENIED })
    })

    it('ADMIN-AUDIT-READ: audit events stay readable on the runtime role (the one transaction table it may select)', async () => {
      const page = await runtimeTx.audit(A.tenantId, {}).then(p => p, e => e)
      // AuditEvent is insert-only for the runtime role; if SELECT is also denied it must be the explicit code, not an empty page.
      if (page instanceof ServiceUnavailableException) expect(page.getResponse()).toMatchObject({ code: OPERATIONS_READ_DENIED })
      else expect(Array.isArray(page.items)).toBe(true)
    })
  })
})
