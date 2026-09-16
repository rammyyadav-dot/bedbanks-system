import { bookings, dashboard, properties } from './mock-data'
import type { SupplierDataAdapter } from './types'

export const mockSupplierAdapter: SupplierDataAdapter = {
  async getDashboard() {
    return dashboard
  },
  async listProperties() {
    return properties
  },
  async listBookings() {
    return bookings
  },
}

export function getSupplierAdapter(): SupplierDataAdapter {
  // Explicit UI seam: replace only after reviewed API contracts are available.
  return mockSupplierAdapter
}
