import type { SearchCriteria, AgentRateOffer, AgentRoomOffer } from '@bedbanks/domain'
import { activeFilterLabel } from './search-summary'

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
    brands: sorted(filters.brands),
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
  return (filters.starRatings?.length ?? 0) + (filters.boardBasisIds?.length ?? 0) + (filters.propertyTypes?.length ?? 0) + (filters.brands?.length ?? 0)
    + (filters.refundableOnly ? 1 : 0) + (filters.minPriceMinor !== undefined || filters.maxPriceMinor !== undefined ? 1 : 0)
}

export type FilterChip = { key: string; label: string; next: Filters }

/**
 * One removable chip per active filter selection, each carrying the filters to apply if that chip is removed.
 * Mirrors filterCount: a chip exists for every selection it counts. Prices show one combined chip for min/max.
 */
export function activeFilterChips(filters: Filters | undefined, currency: string, boards: Array<{ id: string; name: string }>): FilterChip[] {
  if (!filters) return []
  const chips: FilterChip[] = []
  for (const star of filters.starRatings ?? []) {
    chips.push({ key: `star:${star}`, label: `${star}★`, next: { ...filters, starRatings: filters.starRatings?.filter((value) => value !== star) } })
  }
  if (filters.refundableOnly) {
    const { refundableOnly: _drop, ...rest } = filters
    chips.push({ key: 'refundable', label: 'Refundable', next: rest })
  }
  for (const boardId of filters.boardBasisIds ?? []) {
    const name = boards.find((board) => board.id === boardId)?.name ?? boardId
    chips.push({ key: `board:${boardId}`, label: name, next: { ...filters, boardBasisIds: filters.boardBasisIds?.filter((value) => value !== boardId) } })
  }
  for (const type of filters.propertyTypes ?? []) {
    chips.push({ key: `type:${type}`, label: type, next: { ...filters, propertyTypes: filters.propertyTypes?.filter((value) => value !== type) } })
  }
  for (const brand of filters.brands ?? []) {
    chips.push({ key: `brand:${brand}`, label: brand, next: { ...filters, brands: filters.brands?.filter((value) => value !== brand) } })
  }
  if (filters.minPriceMinor !== undefined || filters.maxPriceMinor !== undefined) {
    const label = activeFilterLabel({ minPriceMinor: filters.minPriceMinor, maxPriceMinor: filters.maxPriceMinor, currency })
    const { minPriceMinor: _min, maxPriceMinor: _max, ...rest } = filters
    if (label) chips.push({ key: 'price', label, next: rest })
  }
  return chips
}

/** Distinct boards offered by one hotel, in first-seen order. Used for the meal chips on the hotel page. */
export function hotelBoards(rooms: AgentRoomOffer[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>()
  for (const room of rooms) for (const rate of room.rates) if (!seen.has(rate.boardBasisId)) seen.set(rate.boardBasisId, rate.boardBasisName)
  return [...seen].map(([id, name]) => ({ id, name }))
}

export type RateView = {
  boardBasisId: string | null
  refundableOnly: boolean
  /** Case-insensitive substring match against the room name. Empty matches every room. */
  roomNameQuery?: string
  /** Inclusive bounds on the rate's total stay price, in the same currency and integer minor units already on screen. */
  minSellMinor?: number | null
  maxSellMinor?: number | null
}

/** Narrows the rates of one hotel already on screen. It never re-prices and never reorders the server's rates. */
export function visibleRooms(rooms: AgentRoomOffer[], view: RateView): AgentRoomOffer[] {
  const query = view.roomNameQuery?.trim().toLocaleLowerCase('en-US') ?? ''
  const keep = (rate: AgentRateOffer) => (view.boardBasisId === null || rate.boardBasisId === view.boardBasisId) && (!view.refundableOnly || rate.cancellation.refundable)
    && (view.minSellMinor == null || rate.sellAmountMinor >= view.minSellMinor) && (view.maxSellMinor == null || rate.sellAmountMinor <= view.maxSellMinor)
  return rooms.flatMap((room) => {
    if (query && !room.name.toLocaleLowerCase('en-US').includes(query)) return []
    const rates = room.rates.filter(keep)
    return rates.length ? [{ ...room, rates }] : []
  })
}

/**
 * Lowest instantly sellable total in a room group, in the currency of its first such rate. On-request and sold-out rates never lead.
 */
export function roomFromMinor(room: AgentRoomOffer): { amountMinor: number; currency: string } | null {
  let lead: { amountMinor: number; currency: string } | null = null
  for (const rate of room.rates) {
    if (rate.availability === 'sold_out' || rate.availability === 'on_request') continue
    if (!lead) lead = { amountMinor: rate.total.amountMinor, currency: rate.total.currency }
    else if (rate.total.currency === lead.currency && rate.total.amountMinor < lead.amountMinor) lead = { amountMinor: rate.total.amountMinor, currency: lead.currency }
  }
  return lead
}
