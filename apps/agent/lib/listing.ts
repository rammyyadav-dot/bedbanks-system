import type { SearchCriteria, SearchRateOffer, SearchRoomOffer } from '@bedbanks/domain'

type Filters = NonNullable<SearchCriteria['filters']>

/**
 * Average nightly amount for display beside the authoritative stay total. Integer minor units, rounded half up, never a float.
 * Returns null when either input is not a safe positive integer.
 */
export function averageNightlyMinor(totalMinor: number, nights: number | null): number | null {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || nights === null || !Number.isSafeInteger(nights) || nights < 1) return null
  const total = BigInt(totalMinor)
  const count = BigInt(nights)
  return Number((total * 2n + count) / (count * 2n))
}

function canonical(filters: Filters | undefined): string {
  if (!filters) return '{}'
  const sorted = <T>(values: T[] | undefined) => values && values.length ? [...values].sort() : undefined
  return JSON.stringify({
    starRatings: sorted(filters.starRatings),
    boardBasisIds: sorted(filters.boardBasisIds),
    propertyTypes: sorted(filters.propertyTypes),
    refundableOnly: filters.refundableOnly ? true : undefined,
    minPriceMinor: filters.minPriceMinor,
    maxPriceMinor: filters.maxPriceMinor,
  })
}

/** True when the drafted sidebar filters equal the filters of the search on screen. */
export function sameFilters(left: Filters | undefined, right: Filters | undefined): boolean {
  return canonical(left) === canonical(right)
}

/** Number of individual filter selections, for the "Filters (n)" control. */
export function filterCount(filters: Filters | undefined): number {
  if (!filters) return 0
  return (filters.starRatings?.length ?? 0) + (filters.boardBasisIds?.length ?? 0) + (filters.propertyTypes?.length ?? 0)
    + (filters.refundableOnly ? 1 : 0) + (filters.minPriceMinor !== undefined || filters.maxPriceMinor !== undefined ? 1 : 0)
}

/** Distinct boards offered by one hotel, in first-seen order. Used for the meal chips on the hotel page. */
export function hotelBoards(rooms: SearchRoomOffer[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>()
  for (const room of rooms) for (const rate of room.rates) if (!seen.has(rate.boardBasisId)) seen.set(rate.boardBasisId, rate.boardBasisName)
  return [...seen].map(([id, name]) => ({ id, name }))
}

export type RateView = { boardBasisId: string | null; refundableOnly: boolean }

/** Narrows the rates of one hotel already on screen. It never re-prices and never reorders the server's rates. */
export function visibleRooms(rooms: SearchRoomOffer[], view: RateView): SearchRoomOffer[] {
  const keep = (rate: SearchRateOffer) => (view.boardBasisId === null || rate.boardBasisId === view.boardBasisId) && (!view.refundableOnly || rate.cancellation.refundable)
  return rooms.flatMap((room) => {
    const rates = room.rates.filter(keep)
    return rates.length ? [{ ...room, rates }] : []
  })
}

/**
 * Lowest instantly sellable total in a room group, in the currency of its first such rate. On-request and sold-out rates never lead.
 */
export function roomFromMinor(room: SearchRoomOffer): { amountMinor: number; currency: string } | null {
  let lead: { amountMinor: number; currency: string } | null = null
  for (const rate of room.rates) {
    if (rate.availability === 'sold_out' || rate.availability === 'on_request') continue
    if (!lead) lead = { amountMinor: rate.total.amountMinor, currency: rate.total.currency }
    else if (rate.total.currency === lead.currency && rate.total.amountMinor < lead.amountMinor) lead = { amountMinor: rate.total.amountMinor, currency: lead.currency }
  }
  return lead
}
