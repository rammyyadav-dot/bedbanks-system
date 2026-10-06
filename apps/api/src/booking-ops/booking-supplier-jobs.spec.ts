import { BOOKING_SUPPLIER_MAX_ATTEMPTS, BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS } from '@bedbanks/contracts'
import { supplierOpsFor } from './booking-supplier-jobs.service'
import { MockBookingSupplier } from './supplier/mock-booking-supplier'
import { BookingSupplierRegistry } from './supplier/booking-supplier.registry'
import { BookingSupplierCallError } from './supplier/booking-supplier.port'

const base = { status: 'PENDING_SUPPLIER' as const, closed: false, supplierStatus: null, hasActiveJob: false, hasRetryWaitJob: false, hasUnknownJob: false, configured: true }
const CTX = { tenantId: 't', requestId: 'r' }
const REQ = (supplierKey: string, reference = 'FB-0123456789ABCDEF0123') => ({ reference, supplierKey, checkIn: '2030-07-01', checkOut: '2030-07-03', currency: 'AED', sellMinor: 100n, rooms: [] })

describe('supplier operations offered (pure)', () => {
  it('SJ-01: send only for an idle Pending supplier booking with an adapter and no unknown outcome', () => {
    expect(supplierOpsFor(base)).toEqual(['send', 'sync'])
    expect(supplierOpsFor({ ...base, hasActiveJob: true })).toEqual([])
    expect(supplierOpsFor({ ...base, configured: false })).toEqual([])
    expect(supplierOpsFor({ ...base, hasUnknownJob: true })).toEqual(['sync']) // never send again while the outcome is unknown
    expect(supplierOpsFor({ ...base, supplierStatus: 'UNKNOWN' })).toEqual(['sync'])
    expect(supplierOpsFor({ ...base, closed: true })).toEqual([])
  })
  it('SJ-02: cancel only from Cancel requested; retry now only when a retry is waiting; sync also for On request', () => {
    expect(supplierOpsFor({ ...base, status: 'CANCEL_REQUESTED' })).toEqual(['cancel', 'sync'])
    expect(supplierOpsFor({ ...base, status: 'ON_REQUEST' })).toEqual(['sync'])
    expect(supplierOpsFor({ ...base, status: 'CONFIRMED' })).toEqual([])
    expect(supplierOpsFor({ ...base, hasActiveJob: true, hasRetryWaitJob: true })).toEqual(['retryNow'])
  })
  it('SJ-03: the retry schedule is the spec’s: a first try and three retries at 30 s, 2 min, 5 min', () => {
    expect([...BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS]).toEqual([30, 120, 300]); expect(BOOKING_SUPPLIER_MAX_ATTEMPTS).toBe(BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS.length + 1)
  })
})

describe('mock supplier and registry', () => {
  it('SJ-04: the ghost scenario books on the first call, throws, and the status check then finds it; flaky books only on the second call', async () => {
    const m = new MockBookingSupplier()
    await expect(m.book(CTX, REQ('mock-ghost'))).rejects.toBeInstanceOf(BookingSupplierCallError)
    expect(await m.statusByReference(CTX, { reference: 'FB-0123456789ABCDEF0123', supplierKey: 'mock-ghost' })).toMatchObject({ found: true, state: 'CONFIRMED' })
    await expect(m.book(CTX, REQ('mock-flaky', 'FB-AAAAAAAAAAAAAAAAAAAA'))).rejects.toBeInstanceOf(BookingSupplierCallError)
    expect(await m.statusByReference(CTX, { reference: 'FB-AAAAAAAAAAAAAAAAAAAA', supplierKey: 'mock-flaky' })).toEqual({ found: false })
    expect(await m.book(CTX, REQ('mock-flaky', 'FB-AAAAAAAAAAAAAAAAAAAA'))).toMatchObject({ outcome: 'CONFIRMED' })
  })
  it('SJ-05: mock-down fails the status check too, so nothing can be concluded', async () => {
    const m = new MockBookingSupplier()
    await expect(m.book(CTX, REQ('mock-down'))).rejects.toMatchObject({ kind: 'transport' })
    await expect(m.statusByReference(CTX, { reference: 'FB-0123456789ABCDEF0123', supplierKey: 'mock-down' })).rejects.toBeInstanceOf(BookingSupplierCallError)
  })
  it('SJ-06: the mock is reachable only with BOTH switches and only for a listed tenant, and only by a mock- supplier name', () => {
    const r = (env: Record<string, string>) => new BookingSupplierRegistry(env)
    expect(r({}).resolve('t1', 'mock-confirm')).toBeNull()
    expect(r({ ALLOW_MOCK_SUPPLIER: 'true' }).resolve('t1', 'mock-confirm')).toBeNull()
    expect(r({ MOCK_SUPPLIER_TENANT_IDS: 't1' }).resolve('t1', 'mock-confirm')).toBeNull()
    expect(r({ ALLOW_MOCK_SUPPLIER: 'true', MOCK_SUPPLIER_TENANT_IDS: 't2, t1' }).resolve('t1', 'mock-confirm')).not.toBeNull()
    expect(r({ ALLOW_MOCK_SUPPLIER: 'true', MOCK_SUPPLIER_TENANT_IDS: 't1' }).resolve('t3', 'mock-confirm')).toBeNull()
    expect(r({ ALLOW_MOCK_SUPPLIER: 'true', MOCK_SUPPLIER_TENANT_IDS: 't1' }).resolve('t1', 'Global Hotel Supply')).toBeNull()
  })
})
