import { Injectable, Optional } from '@nestjs/common'
import type { BookingSupplierPort, BookingSupplierResolver } from './booking-supplier.port'
import { MockBookingSupplier } from './mock-booking-supplier'

/**
 * Which supplier adapter serves a booking (ADR 0039, Phase 3). Today there is no production adapter for the Admin booking queue, so for a real tenant
 * `resolve` returns null and the screens say "supplier not configured". The mock is available only for tenants explicitly named in
 * `MOCK_SUPPLIER_TENANT_IDS` while `ALLOW_MOCK_SUPPLIER=true`; both must be set, so it cannot be switched on for a real tenant by one flag or by a supplier name.
 */
@Injectable()
export class BookingSupplierRegistry implements BookingSupplierResolver {
  private readonly mock = new MockBookingSupplier()

  constructor(@Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  mockAllowed(tenantId: string): boolean {
    if (this.env.ALLOW_MOCK_SUPPLIER !== 'true') return false
    return (this.env.MOCK_SUPPLIER_TENANT_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean).includes(tenantId)
  }

  resolve(tenantId: string, supplierKey: string): BookingSupplierPort | null {
    if (/^mock-/i.test(supplierKey) && this.mockAllowed(tenantId)) return this.mock
    return null
  }

  /** The mock instance, for the scenario to follow a reference across book, cancel and status calls. Null when the mock is not allowed for the tenant. */
  mockFor(tenantId: string): MockBookingSupplier | null { return this.mockAllowed(tenantId) ? this.mock : null }
}
