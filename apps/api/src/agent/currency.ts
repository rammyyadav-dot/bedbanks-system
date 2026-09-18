import { BadRequestException } from '@nestjs/common'

/** Approved fBeds launch settlement currencies (ISO 4217). */
export const SUPPORTED_SETTLEMENT_CURRENCIES = ['AED', 'USD', 'EUR', 'INR', 'GBP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'AUD', 'CAD', 'JPY'] as const
export type SupportedSettlementCurrency = typeof SUPPORTED_SETTLEMENT_CURRENCIES[number]

export function assertSupportedSettlementCurrency(value: string): asserts value is SupportedSettlementCurrency {
  if (!SUPPORTED_SETTLEMENT_CURRENCIES.includes(value as SupportedSettlementCurrency)) {
    throw new BadRequestException('Unsupported settlement currency')
  }
}
