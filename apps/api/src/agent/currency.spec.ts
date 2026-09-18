import { BadRequestException } from '@nestjs/common'
import { assertSupportedSettlementCurrency, SUPPORTED_SETTLEMENT_CURRENCIES } from './currency'

describe('settlement currency validation', () => {
  it('accepts every explicitly approved launch currency', () => {
    for (const currency of SUPPORTED_SETTLEMENT_CURRENCIES) {
      expect(() => assertSupportedSettlementCurrency(currency)).not.toThrow()
    }
  })

  it.each(['usd', ' USD', 'USD ', 'US', 'USDD', 'XXX'])('rejects malformed or unsupported currency %p', (currency) => {
    expect(() => assertSupportedSettlementCurrency(currency)).toThrow(BadRequestException)
  })
})
