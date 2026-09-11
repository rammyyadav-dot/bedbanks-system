import type { Hotel, HotelSearchCriteria, HotelSearchResult } from '@/types/hotel'

export interface HotelService {
  search(criteria: HotelSearchCriteria): Promise<HotelSearchResult>
  getById(id: string): Promise<Hotel | null>
}

export class ApiHotelService implements HotelService {
  constructor(private readonly baseUrl = process.env.NEXT_PUBLIC_API_URL ?? '') {}

  async search(criteria: HotelSearchCriteria): Promise<HotelSearchResult> {
    if (!this.baseUrl) return { hotels: [], total: 0, isDemo: false, source: 'api' }
    const response = await fetch(`${this.baseUrl}/api/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(criteria),
    })
    if (!response.ok) throw new Error('Hotel search request failed')
    return response.json() as Promise<HotelSearchResult>
  }

  async getById(id: string): Promise<Hotel | null> {
    if (!this.baseUrl) return null
    const response = await fetch(`${this.baseUrl}/api/v1/hotels/${encodeURIComponent(id)}`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('Hotel request failed')
    return response.json() as Promise<Hotel>
  }
}
