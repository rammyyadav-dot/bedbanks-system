import { UnconfiguredSupplierAdapter } from './supplier.port'

describe('agent supplier boundary', () => {
  it('fails honestly when no supplier is configured', async () => {
    const supplier = new UnconfiguredSupplierAdapter()
    await expect(supplier.search()).resolves.toEqual({ offers: [], providerSummary: { queried: 0, succeeded: 0, failed: 0 } })
    await expect(supplier.recheck()).rejects.toThrow('No supplier adapter configured')
    await expect(supplier.prebook()).rejects.toThrow('No supplier adapter configured')
  })
})
