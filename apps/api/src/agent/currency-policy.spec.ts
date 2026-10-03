import { BadRequestException } from '@nestjs/common'
import { DEFAULT_ENABLED_CURRENCIES, enabledCurrency, enabledSettlementCurrencies } from './currency'

describe('launch currency policy (ADR 0029)', () => {
  const original = process.env.SETTLEMENT_CURRENCIES
  afterEach(() => { if (original === undefined) delete process.env.SETTLEMENT_CURRENCIES; else process.env.SETTLEMENT_CURRENCIES = original })

  it('is AED only when nothing is configured', () => {
    expect(DEFAULT_ENABLED_CURRENCIES).toEqual(['AED'])
    expect(enabledSettlementCurrencies({} as NodeJS.ProcessEnv)).toEqual(['AED'])
    expect(enabledSettlementCurrencies({ SETTLEMENT_CURRENCIES: '  ' } as unknown as NodeJS.ProcessEnv)).toEqual(['AED'])
  })
  it('reads an explicit list, first entry first, and normalises case and spaces', () => {
    expect(enabledSettlementCurrencies({ SETTLEMENT_CURRENCIES: ' usd , aed' } as unknown as NodeJS.ProcessEnv)).toEqual(['USD', 'AED'])
  })
  it('tolerates a trailing comma', () => {
    expect(enabledSettlementCurrencies({ SETTLEMENT_CURRENCIES: 'AED,' } as unknown as NodeJS.ProcessEnv)).toEqual(['AED'])
  })
  it('throws on a typo, a duplicate or an unsupported code instead of falling back', () => {
    for (const bad of ['XXX', 'AED,AED', 'AE', 'AED;USD', ',']) expect(() => enabledSettlementCurrencies({ SETTLEMENT_CURRENCIES: bad } as unknown as NodeJS.ProcessEnv)).toThrow(/SETTLEMENT_CURRENCIES/)
  })
  it('refuses a currency that is not enabled, with a coded error, and normalises one that is', () => {
    process.env.SETTLEMENT_CURRENCIES = 'AED'
    expect(enabledCurrency(' aed ')).toBe('AED')
    for (const bad of ['USD', 'EUR', '', undefined, 42, 'AEDX']) {
      try { enabledCurrency(bad); throw new Error('should have thrown') } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException)
        expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'CURRENCY_NOT_ENABLED' })
      }
    }
  })
})
