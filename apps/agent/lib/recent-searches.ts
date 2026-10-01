export type RecentSearch = {
  destination: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
}

const limit = 6

export function recentSearchKey(userId: string) {
  return `fbeds.agent.recent-searches.${userId}`
}

function isRecentSearch(value: unknown): value is RecentSearch {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const ages = item.childAges
  return typeof item.destination === 'string' && item.destination.trim().length > 0
    && typeof item.checkIn === 'string' && typeof item.checkOut === 'string'
    && Number.isInteger(item.rooms) && Number.isInteger(item.adults) && Number.isInteger(item.children)
    && Array.isArray(ages) && ages.every((age) => Number.isInteger(age))
    && ages.length === item.children
}

function sameSearch(left: RecentSearch, right: RecentSearch) {
  return left.destination.trim().toLowerCase() === right.destination.trim().toLowerCase()
    && left.checkIn === right.checkIn && left.checkOut === right.checkOut
    && left.rooms === right.rooms && left.adults === right.adults && left.children === right.children
    && left.childAges.join(',') === right.childAges.join(',')
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
  }
}

export function rememberRecentSearch(storage: Pick<Storage, 'getItem' | 'setItem'>, userId: string, search: RecentSearch) {
  if (!userId || !isRecentSearch(search)) return
  const clean = storedSearch(search)
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
