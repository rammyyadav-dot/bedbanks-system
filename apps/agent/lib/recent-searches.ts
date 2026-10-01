import { isGuestMarket } from './guest-markets.mjs'

export type RecentSearch = {
  destination: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  nationality?: string
  starRatings?: number[]
  refundableOnly?: boolean
  minPriceMinor?: number
  maxPriceMinor?: number
}

const limit = 8

function validStars(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 5 && value.every((star) => Number.isInteger(star) && star >= 1 && star <= 5)
}

function validMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function recentSearchKey(userId: string) {
  return `fbeds.agent.recent-searches.${userId}`
}

function isRecentSearch(value: unknown): value is RecentSearch {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const ages = item.childAges
  if (item.nationality !== undefined && !isGuestMarket(item.nationality)) return false
  if (item.starRatings !== undefined && !validStars(item.starRatings)) return false
  if (item.refundableOnly !== undefined && item.refundableOnly !== true) return false
  if (item.minPriceMinor !== undefined && !validMinor(item.minPriceMinor)) return false
  if (item.maxPriceMinor !== undefined && !validMinor(item.maxPriceMinor)) return false
  if (validMinor(item.minPriceMinor) && validMinor(item.maxPriceMinor) && item.maxPriceMinor < item.minPriceMinor) return false
  return typeof item.destination === 'string' && item.destination.trim().length > 0
    && typeof item.checkIn === 'string' && typeof item.checkOut === 'string'
    && Number.isInteger(item.rooms) && Number.isInteger(item.adults) && Number.isInteger(item.children)
    && Array.isArray(ages) && ages.every((age) => Number.isInteger(age))
    && ages.length === item.children
}

function starsKey(stars: number[] | undefined) {
  return [...(stars ?? [])].sort((a, b) => a - b).join(',')
}

function sameSearch(left: RecentSearch, right: RecentSearch) {
  return left.destination.trim().toLowerCase() === right.destination.trim().toLowerCase()
    && left.checkIn === right.checkIn && left.checkOut === right.checkOut
    && left.rooms === right.rooms && left.adults === right.adults && left.children === right.children
    && left.childAges.join(',') === right.childAges.join(',')
    && (left.nationality ?? '') === (right.nationality ?? '')
    && starsKey(left.starRatings) === starsKey(right.starRatings)
    && Boolean(left.refundableOnly) === Boolean(right.refundableOnly)
    && (left.minPriceMinor ?? '') === (right.minPriceMinor ?? '')
    && (left.maxPriceMinor ?? '') === (right.maxPriceMinor ?? '')
}

export function readRecentSearches(storage: Pick<Storage, 'getItem'>, userId: string): RecentSearch[] {
  if (!userId) return []
  try {
    const parsed = JSON.parse(storage.getItem(recentSearchKey(userId)) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentSearch).slice(0, limit).map((item) => ({
      destination: item.destination.trim(),
      checkIn: item.checkIn,
      checkOut: item.checkOut,
      rooms: item.rooms,
      adults: item.adults,
      children: item.children,
      childAges: [...item.childAges],
      ...(item.nationality ? { nationality: item.nationality } : {}),
      ...(item.starRatings ? { starRatings: [...item.starRatings].sort((a, b) => a - b) } : {}),
      ...(item.refundableOnly ? { refundableOnly: true as const } : {}),
      ...(item.minPriceMinor !== undefined ? { minPriceMinor: item.minPriceMinor } : {}),
      ...(item.maxPriceMinor !== undefined ? { maxPriceMinor: item.maxPriceMinor } : {}),
    }))
  } catch {
    return []
  }
}

function storedSearch(search: RecentSearch): RecentSearch {
  return {
    destination: search.destination.trim(),
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    rooms: search.rooms,
    adults: search.adults,
    children: search.children,
    childAges: [...search.childAges],
    ...(search.nationality && isGuestMarket(search.nationality) ? { nationality: search.nationality } : {}),
    ...(search.starRatings?.length ? { starRatings: [...search.starRatings].sort((a, b) => a - b) } : {}),
    ...(search.refundableOnly ? { refundableOnly: true as const } : {}),
    ...(search.minPriceMinor !== undefined ? { minPriceMinor: search.minPriceMinor } : {}),
    ...(search.maxPriceMinor !== undefined ? { maxPriceMinor: search.maxPriceMinor } : {}),
  }
}

export function deleteRecentSearch(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, userId: string, search: RecentSearch) {
  if (!userId) return
  const next = readRecentSearches(storage, userId).filter((item) => !sameSearch(item, search))
  if (next.length === 0) storage.removeItem(recentSearchKey(userId))
  else storage.setItem(recentSearchKey(userId), JSON.stringify(next))
}

export function rememberRecentSearch(storage: Pick<Storage, 'getItem' | 'setItem'>, userId: string, search: RecentSearch) {
  const candidate: RecentSearch = { ...search, childAges: [...search.childAges] }
  if (!candidate.starRatings?.length) delete candidate.starRatings
  if (!candidate.refundableOnly) delete candidate.refundableOnly
  if (!userId || !isRecentSearch(candidate)) return
  const clean = storedSearch(candidate)
  const next = [clean, ...readRecentSearches(storage, userId).filter((item) => !sameSearch(item, clean))].slice(0, limit)
  storage.setItem(recentSearchKey(userId), JSON.stringify(next))
}

export function clearRecentSearches(storage: Pick<Storage, 'removeItem'>, userId: string) {
  if (userId) storage.removeItem(recentSearchKey(userId))
}

const sessionMark = 'fbeds.agent.had-session'

export function markAgentSession(storage: Pick<Storage, 'setItem'>) {
  storage.setItem(sessionMark, '1')
}

export function clearAgentSessionMark(storage: Pick<Storage, 'removeItem'>) {
  storage.removeItem(sessionMark)
}

export function consumeExpiredSession(storage: Pick<Storage, 'getItem' | 'removeItem'>) {
  if (storage.getItem(sessionMark) !== '1') return false
  storage.removeItem(sessionMark)
  return true
}
