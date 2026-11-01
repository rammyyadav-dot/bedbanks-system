import type { SearchRateOffer } from '@bedbanks/domain'

/**
 * Maps a contracted plan's recorded payment type to the offer value (ADR 0057).
 * A plan with nothing recorded is `unspecified`; it is never presented as prepaid.
 */
export function offerPaymentType(recorded: string | null | undefined): SearchRateOffer['paymentType'] {
  if (recorded === 'PREPAID') return 'prepaid'
  if (recorded === 'PAY_AT_HOTEL') return 'pay_at_hotel'
  return 'unspecified'
}
