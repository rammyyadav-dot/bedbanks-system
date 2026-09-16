export interface CanonicalHotel { id: string; name: string; destinationId: string; providerRefs: Record<string, string> }
export interface SearchCriteria { destination: string; checkIn: string; checkOut: string; rooms: number; adults: number; children: number; nationality: string; currency: string }
export interface CanonicalRate { id: string; hotelId: string; currency: string; totalMinor: number; refundable: boolean }
