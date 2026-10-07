import type { DestinationRef, SearchRoomStay, SearchSort } from '@bedbanks/domain'
import { buildRoomStays } from './occupancy.ts'
import { isGuestMarket } from './guest-markets.mjs'

const SELLING_CURRENCIES = ['AED', 'USD', 'EUR', 'GBP', 'INR', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'AUD', 'CAD', 'JPY'] as const

export type RecentSearch = {
  destination: string
  cityName?: string
  destinationRef?: DestinationRef
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  roomStays?: SearchRoomStay[]
  nationality?: string
  currency?: string
  sort?: SearchSort
  starRatings?: number[]
  refundableOnly?: boolean
  minPriceMinor?: number
  maxPriceMinor?: number
  boardBasisIds?: string[]
  propertyTypes?: string[]
}

const limit = 8

function validStars(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 5 && value.every((star) => Number.isInteger(star) && star >= 1 && star <= 5)
}

function validMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function recentSearchKey(userId: string, tenantId?: string) {
  return `fbeds.agent.recent-searches.${userId}${tenantId ? `.tenant.${encodeURIComponent(tenantId)}` : ''}`
}

function validRef(value: unknown): value is DestinationRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  if (ref.type === 'hotel') return typeof ref.id === 'string' && ref.id.trim().length > 0
  return ref.type === 'city' && typeof ref.id === 'string' && typeof ref.countryCode === 'string' && ref.id.startsWith(`city:${ref.countryCode}:`)
}

function validStays(value: unknown): value is SearchRoomStay[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false
  const drafts = value.map((stay) => {
    if (!stay || typeof stay !== 'object' || !Array.isArray((stay as { children?: unknown }).children)) return null
    const row = stay as { adults: number; children: { age: number }[] }
    if (row.children.some((child) => !child || typeof child !== 'object')) return null
    return { adults: row.adults, childAges: row.children.map((child) => child.age) }
  })
  return drafts.every((stay) => stay !== null) && buildRoomStays(drafts as { adults: number; childAges: number[] }[]).ok
}

export function canReplayRecentSearch(item: RecentSearch): boolean {
  if (!validRef(item.destinationRef) || !validStays(item.roomStays) || typeof item.currency !== 'string' || !SELLING_CURRENCIES.includes(item.currency as typeof SELLING_CURRENCIES[number])) return false
  if (item.destinationRef.type === 'hotel') return typeof item.cityName === 'string' && item.cityName.trim().length > 0
  return true
}

function isRecentSearch(value: unknown): value is RecentSearch {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const ages = item.childAges
  if (item.boardBasisIds !== undefined && (!Array.isArray(item.boardBasisIds) || !item.boardBasisIds.every((id) => typeof id === 'string' && id.trim()))) return false
  if (item.propertyTypes !== undefined && (!Array.isArray(item.propertyTypes) || !item.propertyTypes.every((type) => typeof type === 'string' && type.trim()))) return false
  if (item.nationality !== undefined && !isGuestMarket(item.nationality)) return false
  if (item.starRatings !== undefined && !validStars(item.starRatings)) return false
  if (item.refundableOnly !== undefined && item.refundableOnly !== true) return false
  if (item.minPriceMinor !== undefined && !validMinor(item.minPriceMinor)) return false
  if (item.maxPriceMinor !== undefined && !validMinor(item.maxPriceMinor)) return false
  if (validMinor(item.minPriceMinor) && validMinor(item.maxPriceMinor) && item.maxPriceMinor < item.minPriceMinor) return false
  if (item.cityName !== undefined && typeof item.cityName !== 'string') return false
  if (item.destinationRef !== undefined && !validRef(item.destinationRef)) return false
  if (item.roomStays !== undefined && !validStays(item.roomStays)) return false
  if (item.currency !== undefined && !SELLING_CURRENCIES.includes(item.currency as typeof SELLING_CURRENCIES[number])) return false
  if (item.sort !== undefined && !['default', 'price', 'stars', 'name'].includes(item.sort as string)) return false
  return typeof item.destination === 'string' && item.destination.trim().length > 0
    && typeof item.checkIn === 'string' && typeof item.checkOut === 'string'
    && Number.isInteger(item.rooms) && Number.isInteger(item.adults) && Number.isInteger(item.children)
    && Array.isArray(ages) && ages.every((age) => Number.isInteger(age))
    && ages.length === item.children
}

function starsKey(stars: number[] | undefined) {
  return [...(stars ?? [])].sort((a, b) => a - b).join(',')
}

export function recentSearchIdentity(item: RecentSearch): string {
  return [
    item.destinationRef ? `${item.destinationRef.type}:${item.destinationRef.id}` : item.destination.trim().toLowerCase(),
    item.roomStays ? JSON.stringify(item.roomStays) : '',
    item.currency ?? '',
    item.sort ?? '',
    item.checkIn,
    item.checkOut,
    String(item.rooms),
    String(item.adults),
    String(item.children),
    item.childAges.join(','),
    item.nationality ?? '',
    starsKey(item.starRatings),
    item.refundableOnly ? '1' : '0',
    item.minPriceMinor ?? '',
    item.maxPriceMinor ?? '',
    [...(item.boardBasisIds ?? [])].sort().join(','),
    [...(item.propertyTypes ?? [])].sort().join(','),
  ].join('|')
}

function sameSearch(left: RecentSearch, right: RecentSearch) {
  return recentSearchIdentity(left) === recentSearchIdentity(right)
}

export function readRecentSearches(storage: Pick<Storage, 'getItem'>, userId: string, tenantId?: string): RecentSearch[] {
  if (!userId) return []
  try {
    const parsed = JSON.parse(storage.getItem(recentSearchKey(userId, tenantId)) ?? '[]') as unknown
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
      ...(typeof item.cityName === 'string' && item.cityName.trim() ? { cityName: item.cityName.trim() } : {}),
      ...(validRef(item.destinationRef) ? { destinationRef: item.destinationRef.type === 'city' ? { type: 'city' as const, id: item.destinationRef.id, countryCode: item.destinationRef.countryCode } : { type: 'hotel' as const, id: item.destinationRef.id } } : {}),
      ...(validStays(item.roomStays) ? { roomStays: item.roomStays.map((stay) => ({ adults: stay.adults, children: stay.children.map((child) => ({ age: child.age })) })) } : {}),
      ...(typeof item.currency === 'string' ? { currency: item.currency } : {}),
      ...(item.sort ? { sort: item.sort } : {}),
      ...(Array.isArray(item.boardBasisIds) ? { boardBasisIds: [...item.boardBasisIds] } : {}),
      ...(Array.isArray(item.propertyTypes) ? { propertyTypes: [...item.propertyTypes] } : {}),
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
    ...(search.cityName?.trim() ? { cityName: search.cityName.trim() } : {}),
    ...(validRef(search.destinationRef) ? { destinationRef: search.destinationRef } : {}),
    ...(validStays(search.roomStays) ? { roomStays: search.roomStays.map((stay) => ({ adults: stay.adults, children: stay.children.map((child) => ({ age: child.age })) })) } : {}),
    ...(search.currency && SELLING_CURRENCIES.includes(search.currency as typeof SELLING_CURRENCIES[number]) ? { currency: search.currency } : {}),
    ...(search.sort ? { sort: search.sort } : {}),
    ...(search.boardBasisIds?.length ? { boardBasisIds: [...search.boardBasisIds] } : {}),
    ...(search.propertyTypes?.length ? { propertyTypes: [...search.propertyTypes] } : {}),
  }
}

export function deleteRecentSearch(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, userId: string, search: RecentSearch, tenantId?: string) {
  if (!userId) return
  const next = readRecentSearches(storage, userId, tenantId).filter((item) => !sameSearch(item, search))
  if (next.length === 0) storage.removeItem(recentSearchKey(userId, tenantId))
  else storage.setItem(recentSearchKey(userId, tenantId), JSON.stringify(next))
}

export function rememberRecentSearch(storage: Pick<Storage, 'getItem' | 'setItem'>, userId: string, search: RecentSearch, tenantId?: string) {
  const candidate: RecentSearch = { ...search, childAges: [...search.childAges] }
  if (!candidate.starRatings?.length) delete candidate.starRatings
  if (!candidate.refundableOnly) delete candidate.refundableOnly
  if (!userId || !isRecentSearch(candidate)) return
  const clean = storedSearch(candidate)
  const next = [clean, ...readRecentSearches(storage, userId, tenantId).filter((item) => !sameSearch(item, clean))].slice(0, limit)
  storage.setItem(recentSearchKey(userId, tenantId), JSON.stringify(next))
}

export function clearRecentSearches(storage: Pick<Storage, 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>, userId: string, tenantId?: string) {
  if (!userId) return
  storage.removeItem(recentSearchKey(userId, tenantId))
  if (tenantId || !storage.key || typeof storage.length !== 'number') return
  const prefix = `${recentSearchKey(userId)}.tenant.`
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) storage.removeItem(key)
  }
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
