import { BookingReconciliationService } from './booking-reconciliation.service'
import { BookingTransactionService } from './booking-transaction.service'
import { BookingCancellationService } from './booking-cancellation.service'
import { BookingDocumentService } from './booking-document.service'
import { BookingQueryService } from './booking-query.service'
import { InventoryHoldService } from './inventory-hold.service'
import { AgentController } from './agent.controller'
import type { SupplierAdapter } from './supplier.port'
import type { AgentFinanceService } from './finance.service'
import type { AgentAuditService } from './audit.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import type { Request, Response } from 'express'
import type { OfferHoldService } from './offer-hold.service'
import { AgentSearchService } from './agent-search.service'

const stayStart = new Date(Date.now() + 30 * 86400000)
const stayEnd = new Date(stayStart.getTime() + 3 * 86400000)
const criteria = { destination: 'Dubai', checkIn: stayStart.toISOString().slice(0, 10), checkOut: stayEnd.toISOString().slice(0, 10),
  rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED' }
const identity = { user: { id: 'user-a' } } as AuthenticatedUser
const hotel = {
  hotelId: 'h1', name: 'Hotel', destination: 'Dubai', starRating: 5, supplierId: 's1', supplierHotelId: 'sh1',
  rooms: [{ roomTypeId: 'r1', name: 'King', supplierRoomId: 'sr1', rates: [{
    offerId: 'o1', hotelId: 'h1', roomTypeId: 'r1', supplierId: 's1', supplierRoomId: 'sr1',
    tenantId: 'tenant-a', providerId: 'provider-a', canonicalHotelId: 'h1', canonicalRoomTypeId: 'r1',
    ratePlanId: 'p1', ratePlanName: 'Flexible', boardBasisId: 'b1', boardBasisName: 'Breakfast',
    supplierRateId: 'sp1', expiresAt: '2099-01-01T00:00:00Z',
    occupancy: { rooms: 1, adults: 2, children: 0, childAges: [] },
    cancellation: { refundable: true, summary: 'Free until deadline' }, availability: 'available', available: true,
    total: { amountMinor: 125099, currency: 'AED' }, netAmountMinor: 110000, taxAmountMinor: 10000,
    feeAmountMinor: 99, totalAmountMinor: 120099, markupAmountMinor: 5000, sellAmountMinor: 125099,
    paymentType: 'credit', source: 'bedbank',
  }] }],
}
function setup(search: jest.Mock, name = 'supplier-a') {
  const supplier = { name, search } as unknown as SupplierAdapter
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AgentAuditService
  const agentSearch = new AgentSearchService(supplier, audit)
  const controller = new AgentController(supplier, {} as AgentFinanceService, audit, {} as OfferHoldService, agentSearch, {} as BookingReconciliationService, {} as BookingTransactionService, {} as BookingCancellationService, {} as BookingDocumentService, {} as BookingQueryService, {} as InventoryHoldService, { apply: async (_tenant: string, value: unknown) => value } as never)
  return { controller, audit, agentSearch }
}
const query = () => ({ ...criteria } as Parameters<AgentController['search']>[0])
const request = () => ({ requestId: 'request-a', activeTenantId: 'tenant-a' }) as unknown as Request
const supplierResult = (offers: unknown[], failed = 0) => ({ offers, providerSummary: { queried: 1, succeeded: failed ? 0 : 1, failed } })

describe('Agent canonical search boundary', () => {
  it('returns one validated nested offer without calculating its total', async () => {
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([hotel])))
    const result = await controller.search(query(), identity, request())
    expect(result.status).toBe('available')
    expect(result.version).toBe(1)
    expect(result.requestId).toBe('request-a')
    expect(result.searchId).toEqual(expect.any(String))
    const firstHotel = result.hotels[0] as typeof hotel
    expect(firstHotel.rooms[0].rates[0].total).toEqual({ amountMinor: 125099, currency: 'AED' })
  })
  it('returns partial only when a failed provider accompanies verified offers', async () => {
    const partial = supplierResult([hotel])
    partial.providerSummary = { queried: 2, succeeded: 1, failed: 1 }
    const { controller } = setup(jest.fn().mockResolvedValue(partial))
    expect((await controller.search(query(), identity, request())).status).toBe('partial')
  })
  it('enforces advertised filters and limit at the API boundary', async () => {
    const other = structuredClone(hotel)
    other.hotelId = 'h2'; other.rooms[0].rates[0].hotelId = 'h2'; other.rooms[0].rates[0].canonicalHotelId = 'h2'
    other.rooms[0].rates[0].offerId = 'o2'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([hotel, other])))
    const result = await controller.search({ ...query(), limit: 1, filters: { starRatings: [5], boardBasisIds: ['b1'], refundableOnly: true,
      minPriceMinor: 125000, maxPriceMinor: 126000 } }, identity, request())
    expect(result.status).toBe('available')
    expect(result.hotels).toHaveLength(1)
    expect(result.pagination).toEqual({ limit: 1, offset: 0, total: 2, hasMore: true, nextOffset: 1 })
  })
  it('returns the next page from the same stable order', async () => {
    const later = structuredClone(hotel)
    later.hotelId = 'h2'
    later.name = 'Later Hotel'
    later.rooms[0].rates[0].hotelId = 'h2'
    later.rooms[0].rates[0].canonicalHotelId = 'h2'
    later.rooms[0].rates[0].offerId = 'o2'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([hotel, later])))
    const page = await controller.search({ ...query(), limit: 1, offset: 1 }, identity, request())
    expect(page.status).toBe('available')
    expect(page.total).toBe(1)
    expect((page.hotels[0] as typeof hotel).hotelId).toBe('h2')
    expect(page.pagination).toEqual({ limit: 1, offset: 1, total: 2, hasMore: false })
  })
  it('fails closed on a cross-tenant canonical offer', async () => {
    const invalid = structuredClone(hotel)
    invalid.rooms[0].rates[0].tenantId = 'tenant-b'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([invalid])))
    expect((await controller.search(query(), identity, request())).status).toBe('mapping_unavailable')
  })
  it('rejects a conflicting board, room or price as mapping unavailable', async () => {
    const invalid = structuredClone(hotel)
    invalid.rooms[0].rates[0].roomTypeId = 'other-room'
    const { controller } = setup(jest.fn().mockResolvedValue(supplierResult([invalid])))
    const result = await controller.search(query(), identity, request())
    expect(result.status).toBe('mapping_unavailable')
    expect(result.hotels).toEqual([])
  })
  it('distinguishes empty search from provider failure', async () => {
    const empty = setup(jest.fn().mockResolvedValue(supplierResult([])))
    expect((await empty.controller.search(query(), identity, request())).status).toBe('no_availability')
    const failed = setup(jest.fn().mockRejectedValue(Error('secret supplier URL')))
    const result = await failed.controller.search(query(), identity, request())
    expect(result.status).toBe('provider_unavailable')
    expect(JSON.stringify(result)).not.toContain('secret supplier URL')
  })
  it('keeps prebook and booking disabled unless BOOKING_ENABLED=true, and delegates to the transaction service when enabled', async () => {
    const { controller, audit } = setup(jest.fn())
    const response = () => ({ status: jest.fn() }) as unknown as Response
    const prebookBody = { inventoryHoldId: 'hold-a', idempotencyKey: 'key-12345678', adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'A', lastName: 'B' } }
    delete process.env.BOOKING_ENABLED
    const off = response()
    expect((await controller.prebook(prebookBody, 'tenant-a', identity, request(), off)).status).toBe('booking_unavailable')
    expect((await controller.createBooking({ bookingId: 'booking-a' }, 'tenant-a', identity, request(), response())).status).toBe('booking_unavailable')
    expect(off.status).toHaveBeenCalledWith(503)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking.prebook.unavailable', payload: { reason: 'booking_disabled' } }))

    const tx = { prebook: jest.fn().mockResolvedValue({ status: 'prebooked', bookingId: 'booking-a' }), confirm: jest.fn().mockResolvedValue({ bookingId: 'booking-a', status: 'CONFIRMED', alreadyConfirmed: false }) }
    const enabled = new AgentController({ name: 's', search: jest.fn() } as unknown as SupplierAdapter, {} as AgentFinanceService, audit, {} as OfferHoldService, {} as AgentSearchService, {} as BookingReconciliationService, tx as unknown as BookingTransactionService, {} as BookingCancellationService, {} as BookingDocumentService, {} as BookingQueryService, {} as InventoryHoldService, { apply: async (_tenant: string, value: unknown) => value } as never)
    process.env.BOOKING_ENABLED = 'true'
    try {
      await expect(enabled.prebook(prebookBody, 'tenant-a', identity, request(), response())).resolves.toMatchObject({ status: 'prebooked' })
      expect(tx.prebook).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', inventoryHoldId: 'hold-a' }))
      await expect(enabled.createBooking({ bookingId: 'booking-a' }, 'tenant-a', identity, request(), response())).resolves.toMatchObject({ status: 'CONFIRMED' })
    } finally { delete process.env.BOOKING_ENABLED }
  })
  it('keeps cancellation and its quote disabled unless BOOKING_ENABLED=true, then delegates', async () => {
    const { controller, audit } = setup(jest.fn())
    const response = () => ({ status: jest.fn() }) as unknown as Response
    delete process.env.BOOKING_ENABLED
    const off = response()
    expect((await controller.cancel('booking-a', { reason: 'x' }, 'tenant-a', identity, request(), off)).status).toBe('booking_unavailable')
    expect(off.status).toHaveBeenCalledWith(503)
    expect((await controller.cancellationQuote('booking-a', 'tenant-a', identity, request(), response()) as { status: string }).status).toBe('booking_unavailable')
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking.cancel.unavailable' }))
    const cancellations = { cancel: jest.fn().mockResolvedValue({ status: 'CANCELLED' }), quote: jest.fn().mockResolvedValue({ refundMinor: '1' }) }
    const enabled = new AgentController({ name: 's', search: jest.fn() } as unknown as SupplierAdapter, {} as AgentFinanceService, audit, {} as OfferHoldService, {} as AgentSearchService, {} as BookingReconciliationService, {} as BookingTransactionService, cancellations as unknown as BookingCancellationService, {} as BookingDocumentService, {} as BookingQueryService, {} as InventoryHoldService, { apply: async (_tenant: string, value: unknown) => value } as never)
    process.env.BOOKING_ENABLED = 'true'
    try {
      await expect(enabled.cancel('booking-a', { reason: 'guest' }, 'tenant-a', identity, request(), response())).resolves.toMatchObject({ status: 'CANCELLED' })
      expect(cancellations.cancel).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', bookingId: 'booking-a', reason: 'guest' }))
      await expect(enabled.cancellationQuote('booking-a', 'tenant-a', identity, request(), response())).resolves.toEqual({ refundMinor: '1' })
    } finally { delete process.env.BOOKING_ENABLED }
  })
  it('keeps booking documents disabled unless BOOKING_ENABLED=true, serves locked-down HTML when enabled, and rejects unknown types', async () => {
    const { controller } = setup(jest.fn())
    delete process.env.BOOKING_ENABLED
    const off = { status: jest.fn() } as unknown as Response
    expect((await controller.bookingDocument('booking-a', 'voucher', 'tenant-a', identity, request(), off) as { status: string }).status).toBe('booking_unavailable')
    expect(off.status).toHaveBeenCalledWith(503)
    const plain = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), send: jest.fn() }
    await controller.bookingDocumentHtml('booking-a', 'voucher', 'tenant-a', identity, request(), plain as unknown as Response)
    expect(plain.status).toHaveBeenCalledWith(503)

    const documents = { get: jest.fn().mockResolvedValue({ type: 'VOUCHER', number: 'VCH-1', issuedAt: '2099-01-01T00:00:00.000Z', bookingStatus: 'CONFIRMED', payload: { bookingReference: 'FB-1' } }) }
    const enabled = new AgentController({ name: 's', search: jest.fn() } as unknown as SupplierAdapter, {} as AgentFinanceService, setup(jest.fn()).audit, {} as OfferHoldService, {} as AgentSearchService, {} as BookingReconciliationService, {} as BookingTransactionService, {} as BookingCancellationService, documents as unknown as BookingDocumentService, {} as BookingQueryService, {} as InventoryHoldService, { apply: async (_tenant: string, value: unknown) => value } as never)
    process.env.BOOKING_ENABLED = 'true'
    try {
      const res = { status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), send: jest.fn() }
      await enabled.bookingDocumentHtml('booking-a', 'voucher', 'tenant-a', identity, request(), res as unknown as Response)
      expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Security-Policy': expect.stringContaining("default-src 'none'"), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }))
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('VCH-1'))
      await expect(enabled.bookingDocument('booking-a', 'receipt', 'tenant-a', identity, request(), { status: jest.fn() } as unknown as Response)).rejects.toThrow('Unknown document type')
    } finally { delete process.env.BOOKING_ENABLED }
  })
})
