import { HotelbedsSandboxTransport, normalizeHotelbedsResponse } from '@bedbanks/connectors-core'
import { BookingSupplierCallError } from './booking-supplier.port'
import { HotelbedsBookingSupplier, type HotelbedsBookingInputsResolver } from './hotelbeds-booking-supplier'

const REF = 'FB-0123456789ABCDEF0123'
const CLIENT = '0123456789ABCDEF0123'
const CTX = { tenantId: 't1', requestId: 'job:1:1' }
const REQ = { reference: REF, supplierKey: 'hotelbeds-sandbox', checkIn: '2030-07-01', checkOut: '2030-07-03', currency: 'AED', sellMinor: 15000n, rooms: [{ roomName: 'Double', boardCode: 'BB', adults: 2, children: 0, childAges: [] }] }
const guests = [{ type: 'AD' as const, name: 'Amal', surname: 'Haddad' }, { type: 'AD' as const, name: 'Sam', surname: 'Reid' }]
const resolverFor = (over: Record<string, unknown> = {}): HotelbedsBookingInputsResolver => ({ resolve: async () => ({ rateKey: 'rate-key-from-checkrates', holder: { name: 'Amal', surname: 'Haddad' }, guests, expectedNetMinor: 11827, ...over }) })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

/** A stateful stand-in for the Hotelbeds TEST host. It holds bookings by clientReference, like the real one, so status-by-reference is meaningful. */
class FakeHotelbeds {
  bookings = new Map<string, { reference: string; clientReference: string; status: 'CONFIRMED' | 'CANCELLED'; totalNet: string }>()
  calls: string[] = []
  netOnBook = '118.27'
  failBookAfterAccepting: 'timeout' | null = null
  refuseBook = false
  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url)); const method = init?.method ?? 'GET'
    this.calls.push(`${method} ${u.pathname}`)
    if (method === 'POST' && u.pathname === '/hotel-api/1.0/hotels') return json({ hotels: { hotels: [{ code: 3424, currency: 'AED', rooms: [{ code: 'DBL.ST', rates: [{ rateKey: 'rate-key-from-search', rateType: 'RECHECK', net: '118.27', boardCode: 'BB', rooms: 1, adults: 2, children: 0, packaging: false, paymentType: 'AT_WEB', cancellationPolicies: [{ amount: '118.27', from: '2030-06-30T00:00:00+04:00' }], taxes: { allIncluded: true, taxes: [{ included: true, amount: '6.69', currency: 'AED' }] } }] }] }] } })
    if (method === 'POST' && u.pathname === '/hotel-api/1.0/checkrates') return json({ hotel: { code: 3424 } })
    if (method === 'POST' && u.pathname === '/hotel-api/1.0/bookings') {
      if (this.refuseBook) return json({ error: { code: 'HOTEL_NOT_AVAILABLE' } }, 409)
      const body = JSON.parse(String(init?.body))
      const held = { reference: `1-${4135098 + this.bookings.size}`, clientReference: body.clientReference, status: 'CONFIRMED' as const, totalNet: this.netOnBook }
      this.bookings.set(body.clientReference, held)
      if (this.failBookAfterAccepting === 'timeout') throw new Error('socket hang up') // the supplier booked, the answer never arrived
      return json({ booking: { ...held, currency: 'AED' } })
    }
    if (method === 'GET' && u.pathname === '/hotel-api/1.0/bookings') {
      const held = this.bookings.get(u.searchParams.get('clientReference') ?? '')
      return json({ bookings: { bookings: held ? [held] : [] } })
    }
    const cancel = /^\/hotel-api\/1\.0\/bookings\/([A-Za-z0-9-]+)$/.exec(u.pathname)
    if (method === 'DELETE' && cancel && u.searchParams.get('cancellationFlag') === 'CANCELLATION') {
      const held = [...this.bookings.values()].find(b => b.reference === cancel[1])
      if (!held) return json({ error: { code: 'BOOKING_NOT_FOUND' } }, 404)
      held.status = 'CANCELLED'
      return json({ booking: { ...held, totalNet: '0.00', currency: 'AED' } })
    }
    return json({ error: { code: 'NOT_FOUND' } }, 404)
  }
}

function build(fake: FakeHotelbeds, resolver = resolverFor(), bookingEnabled = true) {
  let t = Date.now()
  const transport = new HotelbedsSandboxTransport({ tenantId: 't1', supplierId: 's1', connectorId: 'c1', enabled: true, bookingEnabled, secretRef: 'ref' }, {
    resolveSecret: async () => ({ apiKey: 'k', secret: 's' }), fetch: (async (...a: Parameters<typeof fetch>) => { t += 2000; return fake.fetch(...a) }) as typeof fetch, now: () => t,
  })
  return { transport, supplier: new HotelbedsBookingSupplier('hotelbeds-sandbox', transport, { supplierId: 's1', connectorId: 'c1' }, resolver, () => new Date(t)) }
}

describe('HotelbedsBookingSupplier against a stateful fake Hotelbeds test host', () => {
  it('search -> checkrates -> book -> status -> cancel -> status, end to end', async () => {
    const fake = new FakeHotelbeds(); const { transport, supplier } = build(fake)
    const ctx = { tenantId: 't1', supplierId: 's1', connectorId: 'c1', correlationId: 'req-1' }
    const [offer] = normalizeHotelbedsResponse(await transport.search({ checkIn: '2030-07-01', checkOut: '2030-07-03', hotelCodes: [3424], rooms: 1, adults: 2, children: 0 }, ctx), '2030-01-01T00:00:00Z')
    expect(offer.rateType).toBe('RECHECK')
    await transport.checkRate(offer.rateKey, 'RECHECK', ctx)

    await expect(supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).resolves.toEqual({ found: false })
    const booked = await supplier.book(CTX, REQ)
    expect(booked).toEqual({ outcome: 'CONFIRMED', supplierRef: '1-4135098', hotelConfirmationNo: null })
    expect(fake.bookings.get(CLIENT)?.status).toBe('CONFIRMED')
    await expect(supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).resolves.toMatchObject({ found: true, state: 'CONFIRMED', supplierRef: '1-4135098' })

    await expect(supplier.cancel(CTX, { reference: REF, supplierKey: 'k', supplierRef: '1-4135098' })).resolves.toEqual({ outcome: 'CANCELLED', supplierCancellationRef: null })
    await expect(supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).resolves.toMatchObject({ found: true, state: 'CANCELLED' })
    // A retried cancel with no stored supplier reference finds the cancelled booking and does not DELETE again.
    const deletes = () => fake.calls.filter(c => c.startsWith('DELETE')).length
    const before = deletes()
    await expect(supplier.cancel(CTX, { reference: REF, supplierKey: 'k', supplierRef: null })).resolves.toEqual({ outcome: 'CANCELLED', supplierCancellationRef: null })
    expect(deletes()).toBe(before)
  })

  it('a booking that was made but whose answer was lost is found by reference: no ghost, no duplicate', async () => {
    const fake = new FakeHotelbeds(); fake.failBookAfterAccepting = 'timeout'
    const { supplier } = build(fake)
    await expect(supplier.book(CTX, REQ)).rejects.toMatchObject({ name: 'BookingSupplierCallError', kind: 'transport' })
    await expect(supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).resolves.toMatchObject({ found: true, state: 'CONFIRMED' })
    expect(fake.bookings.size).toBe(1)
  })

  it('a definite supplier refusal is REJECTED and holds nothing', async () => {
    const fake = new FakeHotelbeds(); fake.refuseBook = true
    const { supplier } = build(fake)
    await expect(supplier.book(CTX, REQ)).resolves.toEqual({ outcome: 'REJECTED', code: 'HOTELBEDS_REFUSED' })
    expect(fake.bookings.size).toBe(0)
  })

  it('a booked price that differs from the expected net is never a clean confirmation', async () => {
    const fake = new FakeHotelbeds(); fake.netOnBook = '119.00'
    const { supplier } = build(fake)
    await expect(supplier.book(CTX, REQ)).rejects.toMatchObject({ kind: 'error', code: 'PRICE_MISMATCH' })
    await expect(supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).resolves.toMatchObject({ found: true }) // visible to the runner, so a person can act
  })

  it('local refusals send nothing: wrong currency, guest count mismatch, unsafe names, bad expected net', async () => {
    const fake = new FakeHotelbeds()
    await expect(build(fake).supplier.book(CTX, { ...REQ, currency: 'USD' })).resolves.toEqual({ outcome: 'REJECTED', code: 'UNSUPPORTED_CURRENCY' })
    await expect(build(fake).supplier.book(CTX, { ...REQ, rooms: [{ ...REQ.rooms[0], adults: 1 }] })).resolves.toEqual({ outcome: 'REJECTED', code: 'GUEST_COUNT_MISMATCH' })
    await expect(build(fake, resolverFor({ holder: { name: '<b>', surname: 'X' } })).supplier.book(CTX, REQ)).resolves.toEqual({ outcome: 'REJECTED', code: 'INVALID_BOOKING_REQUEST' })
    await expect(build(fake, resolverFor({ expectedNetMinor: 118.27 })).supplier.book(CTX, REQ)).resolves.toEqual({ outcome: 'REJECTED', code: 'INVALID_EXPECTED_NET' })
    await expect(build(fake).supplier.book(CTX, { ...REQ, reference: 'FB-lowercase' })).resolves.toEqual({ outcome: 'REJECTED', code: 'INVALID_BOOKING_REQUEST' })
    expect(fake.calls).toEqual([])
  })

  it('unavailable inputs never reach the supplier, and a transport left read-only cannot book at all', async () => {
    const fake = new FakeHotelbeds()
    const none: HotelbedsBookingInputsResolver = { resolve: async () => { throw new Error('no guests on file') } }
    await expect(build(fake, none).supplier.book(CTX, REQ)).rejects.toMatchObject({ code: 'BOOK_INPUTS_UNAVAILABLE' })
    await expect(build(fake, resolverFor(), false).supplier.book(CTX, REQ)).rejects.toMatchObject({ kind: 'error', code: 'DISABLED' })
    await expect(build(fake, resolverFor(), false).supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).rejects.toBeInstanceOf(BookingSupplierCallError)
    expect(fake.calls).toEqual([])
  })

  it('an unreachable supplier cannot be mistaken for "nothing held"', async () => {
    const fake = new FakeHotelbeds(); fake.fetch = async () => { throw new Error('down') }
    await expect(build(fake).supplier.statusByReference(CTX, { reference: REF, supplierKey: 'k' })).rejects.toBeInstanceOf(BookingSupplierCallError)
    await expect(build(fake).supplier.cancel(CTX, { reference: REF, supplierKey: 'k', supplierRef: '1-4135098' })).rejects.toBeInstanceOf(BookingSupplierCallError)
  })
})
