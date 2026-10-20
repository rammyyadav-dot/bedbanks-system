import type { AgentRateOffer } from '@bedbanks/domain'
import { formatMinorAmount } from './format'

const BASIS: Record<string, string> = { PER_ROOM_PER_NIGHT: '/ room / night', PER_PERSON_PER_NIGHT: '/ person / night', PER_ROOM_PER_STAY: '/ room / stay', PER_PERSON_PER_STAY: '/ person / stay' }

/**
 * Charges the guest pays the hotel directly (ADR 0067, F-04), one line each: "Tourism Dirham AED 20.00 / room / night (about AED 60.00 for this stay)".
 * They are never part of the total; the agent must tell the guest.
 */
export function payAtHotelLines(rate: Pick<AgentRateOffer, 'payAtHotel'>): string[] {
  return (rate.payAtHotel ?? []).flatMap((charge) => {
    const each = formatMinorAmount(charge.amountMinor, charge.currency)
    const stay = formatMinorAmount(charge.estimatedTotalMinor, charge.currency)
    return each && stay ? [`${charge.label} ${each} ${BASIS[charge.basis] ?? ''} (about ${stay} for this stay)`] : []
  })
}

/** What the contracted price says it includes, or null when the provider did not say. */
export function priceIncludesText(rate: Pick<AgentRateOffer, 'priceIncludes'>): string | null {
  if (!rate.priceIncludes) return null
  const { taxes, fees } = rate.priceIncludes
  if (taxes && fees) return 'Price includes taxes and service fees'
  if (taxes) return 'Price includes taxes; service fees not included'
  if (fees) return 'Price includes service fees; taxes not included'
  return 'Taxes and service fees not included in the price'
}
