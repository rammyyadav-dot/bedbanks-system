import { priceRate, UnconfiguredSupplierAdapter } from './supplier.port'

describe('agent supplier boundary', () => {
  it('calculates server-side pricing without trusting client totals', () => {
    const quote = priceRate({ rateId: 'rate-1', roomName: 'Deluxe', board: 'Room only', currency: 'USD', totalMinor: 12500, refundable: true }, 1500)
    expect(quote).toEqual({ currency: 'USD', subtotalMinor: 12500, markupMinor: 1500, totalMinor: 14000 })
  })

  it('fails honestly when no supplier is configured', async () => {
    const supplier = new UnconfiguredSupplierAdapter()
    await expect(supplier.search()).resolves.toEqual([])
    await expect(supplier.recheck()).rejects.toThrow('No supplier adapter configured')
  })
})
