import { BadRequestException } from '@nestjs/common'

/** Every ISO 4217 currency the platform can represent. Which of them are offered is the launch policy below (ADR 0029). */
export const SUPPORTED_SETTLEMENT_CURRENCIES = ['AED', 'USD', 'EUR', 'INR', 'GBP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'AUD', 'CAD', 'JPY'] as const
export type SupportedSettlementCurrency = typeof SUPPORTED_SETTLEMENT_CURRENCIES[number]

/** Launch policy (ADR 0029): AED only. */
export const DEFAULT_ENABLED_CURRENCIES: readonly SupportedSettlementCurrency[] = ['AED']

/**
 * The currencies enabled for this deployment: `SETTLEMENT_CURRENCIES` (comma-separated ISO codes) or AED when unset. The first entry is the
 * default. An unknown or malformed value throws instead of falling back, so a typo can never silently enable or disable a currency.
 */
export function enabledSettlementCurrencies(env: NodeJS.ProcessEnv = process.env): readonly SupportedSettlementCurrency[] {
  const raw = env.SETTLEMENT_CURRENCIES?.trim()
  if (!raw) return DEFAULT_ENABLED_CURRENCIES
  const list = raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  if (list.length === 0 || new Set(list).size !== list.length || list.some((c) => !(SUPPORTED_SETTLEMENT_CURRENCIES as readonly string[]).includes(c))) {
    throw new Error(`SETTLEMENT_CURRENCIES must be a comma-separated list of distinct supported ISO codes (${SUPPORTED_SETTLEMENT_CURRENCIES.join(', ')})`)
  }
  return list as SupportedSettlementCurrency[]
}

export const defaultSettlementCurrency = (): SupportedSettlementCurrency => enabledSettlementCurrencies()[0]

export function assertSupportedSettlementCurrency(value: string): asserts value is SupportedSettlementCurrency {
  if (!(enabledSettlementCurrencies() as readonly string[]).includes(value)) {
    throw new BadRequestException({ message: `Currency is not enabled. Enabled: ${enabledSettlementCurrencies().join(', ')}.`, code: 'CURRENCY_NOT_ENABLED' })
  }
}

/** A currency code written by staff (contract, rate plan, rate): trimmed, upper-cased, and refused unless enabled. */
export function enabledCurrency(raw: unknown): SupportedSettlementCurrency {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  assertSupportedSettlementCurrency(value)
  return value
}
