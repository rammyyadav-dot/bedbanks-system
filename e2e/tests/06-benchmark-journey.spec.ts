import { expect, test } from '@playwright/test'
import { call, login, offerSearchBody, SELLABLE_STAY } from '../support/api'
import { fixtures } from '../support/helpers'

/**
 * The bedbank value chain on one hotel, end to end across the three portals' API:
 * contracted by the supplier -> managed and readiness-checked by the platform admin -> found, priced and rechecked by the agent.
 * Every hop must see the SAME canonical hotel, and no hop may see another tenant's.
 */
test.describe('Benchmark journey: supplier content -> admin readiness -> agent sale (booking closed)', () => {
  test('J1 one canonical hotel is visible to all three roles, at one integer AED price', async () => {
    const f = fixtures()
    const stay = SELLABLE_STAY()

    // Supplier Alpha sees its mapped hotel.
    const supplierCookie = (await login('supplierEditor')).cookie
    const supplierHotels = await call('/supplier/extranet/hotels', { cookie: supplierCookie })
    expect(supplierHotels.status).toBe(200)
    const supplierRows: any[] = supplierHotels.body.data.hotels ?? supplierHotels.body.data.items ?? supplierHotels.body.data
    expect(supplierRows.map((h) => h.name ?? h.hotelName)).toEqual(['Preview Marina Dubai'])
    const marinaId = f.hotelAlpha

    // The platform admin manages the same hotel and the API computes its readiness.
    const adminCookie = (await login('admin')).cookie
    const adminHotels = await call('/supply/hotels', { cookie: adminCookie })
    expect(adminHotels.status).toBe(200)
    const adminList: any[] = adminHotels.body.data.hotels ?? adminHotels.body.data.items ?? adminHotels.body.data
    const adminIds = adminList.map((h) => h.id ?? h.hotelId)
    expect(adminIds).toContain(marinaId)
    expect(adminIds).not.toContain(f.hotelTenantB)

    // The agent finds that same canonical hotel with a whole-number AED price.
    const agentCookie = (await login('agent')).cookie
    const search = await call('/agent/search', { cookie: agentCookie, headers: { 'x-fbeds-tenant-id': f.tenantA }, json: offerSearchBody(stay.checkIn, stay.checkOut) })
    const agentHotel = search.body.data.hotels.find((h: any) => h.hotelId === marinaId)
    expect(agentHotel, 'the agent search returns the hotel the supplier and admin see').toBeTruthy()
    const rate = agentHotel.rooms[0].rates[0]
    expect(rate.total).toEqual({ amountMinor: 90000, currency: 'AED' }) // 2 nights x 45,000 fils
    expect(rate.sellAmountMinor).toBe(rate.totalAmountMinor + rate.markupAmountMinor)
    expect(search.body.data.hotels.map((h: any) => h.hotelId)).not.toContain(f.hotelTenantB)
  })
})
