export type Hotel = {
  id: string
  name: string
  city: string
  country?: string
  stars: number
  rating: number
  price: number
  rack: number
  rooms: number
  supplier: string
  board: string
  image: string
  amenities: string[]
  distance: string
  reviews: number
  cancellation: string
  mappingStatus?: 'mapped' | 'partial' | 'unmapped'
  availabilityStatus?: 'available' | 'limited' | 'sold-out'
}

export type HotelSearchCriteria = {
  destination: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  nationality: string
  currency: string
}

export type HotelSearchResult = {
  hotels: Hotel[]
  total: number
  isDemo: boolean
  source: 'mock' | 'api'
}
