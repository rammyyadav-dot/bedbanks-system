export function appendHotelPage<T extends { hotelId: string }>(current: T[], incoming: T[]): { hotels: T[]; added: T[] } {
  const seen = new Set(current.map((hotel) => hotel.hotelId))
  const added = incoming.filter((hotel) => {
    if (seen.has(hotel.hotelId)) return false
    seen.add(hotel.hotelId)
    return true
  })
  return { hotels: [...current, ...added], added }
}

/**
 * Pagination after "load more": the window still starts at the first loaded page, `total` stays the server's total and `hasMore`/`nextOffset`
 * come from the newest page. The list then holds every page loaded so far, so "Showing 1–N of total" stays accurate.
 */
export function paginationAfterLoadMore(current: { offset?: number; limit?: number } | undefined, next: { limit: number; offset: number; total: number; hasMore: boolean; nextOffset?: number } | undefined, loadedCount: number): { limit: number; offset: number; total: number; hasMore: boolean; nextOffset?: number } {
  const offset = current?.offset ?? 0
  if (!next) return { limit: current?.limit ?? loadedCount, offset, total: loadedCount, hasMore: false }
  return { ...next, offset }
}
