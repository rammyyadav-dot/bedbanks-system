export function appendHotelPage<T extends { hotelId: string }>(current: T[], incoming: T[]): { hotels: T[]; added: T[] } {
  const seen = new Set(current.map((hotel) => hotel.hotelId))
  const added = incoming.filter((hotel) => {
    if (seen.has(hotel.hotelId)) return false
    seen.add(hotel.hotelId)
    return true
  })
  return { hotels: [...current, ...added], added }
}
