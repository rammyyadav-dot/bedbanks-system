/**
 * Hotel rooms and amenities contracts (ADR 0021, stage 2).
 *
 * - Rooms are the canonical Room Master (`RoomType`). Rooms are archived, never deleted: referenced rooms, rate plans and mappings stay.
 * - Bedding and extra-bed support live in the existing `beddingMetadata` JSON column under known keys; other keys are preserved.
 * - Child-age rules are contract policies (`ChildPolicy`) and are shown read-only beside the rooms; they are never edited here.
 * - Amenities come from a controlled catalogue. A missing selection means "not recorded"; `UNKNOWN` fee is an explicit answer.
 */

export const BED_TYPES = ['SINGLE', 'DOUBLE', 'QUEEN', 'KING', 'TWIN', 'SOFA_BED', 'BUNK'] as const;
export type BedType = (typeof BED_TYPES)[number];
export const EXTRA_BED_SUPPORT = ['SUPPORTED', 'NOT_SUPPORTED', 'UNKNOWN'] as const;
export type ExtraBedSupport = (typeof EXTRA_BED_SUPPORT)[number];
export const ROOM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface RoomBedding {
  description: string | null
  beds: Array<{ type: BedType; count: number }>
  extraBed: ExtraBedSupport
}

export const AMENITY_FEE_TYPES = ['FREE', 'PAID', 'UNKNOWN'] as const;
export type AmenityFeeType = (typeof AMENITY_FEE_TYPES)[number];
export type AmenityScope = 'HOTEL' | 'ROOM' | 'BOTH';
export const AMENITY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The controlled amenity catalogue. Codes are stable identifiers; labels are display text. */
export const AMENITY_CATALOGUE = [
  { code: 'WIFI', label: 'Wi-Fi', scope: 'BOTH' },
  { code: 'POOL', label: 'Swimming pool', scope: 'HOTEL' },
  { code: 'SPA', label: 'Spa', scope: 'HOTEL' },
  { code: 'GYM', label: 'Fitness centre', scope: 'HOTEL' },
  { code: 'PARKING', label: 'Parking', scope: 'HOTEL' },
  { code: 'AIRPORT_SHUTTLE', label: 'Airport shuttle', scope: 'HOTEL' },
  { code: 'RESTAURANT', label: 'Restaurant', scope: 'HOTEL' },
  { code: 'BAR', label: 'Bar', scope: 'HOTEL' },
  { code: 'ROOM_SERVICE', label: 'Room service', scope: 'BOTH' },
  { code: 'BREAKFAST', label: 'Breakfast available', scope: 'HOTEL' },
  { code: 'CONCIERGE', label: 'Concierge', scope: 'HOTEL' },
  { code: 'LAUNDRY', label: 'Laundry', scope: 'HOTEL' },
  { code: 'BUSINESS_CENTRE', label: 'Business centre', scope: 'HOTEL' },
  { code: 'MEETING_ROOMS', label: 'Meeting rooms', scope: 'HOTEL' },
  { code: 'KIDS_CLUB', label: 'Kids club', scope: 'HOTEL' },
  { code: 'BEACH_ACCESS', label: 'Beach access', scope: 'HOTEL' },
  { code: 'WHEELCHAIR_ACCESS', label: 'Wheelchair accessible', scope: 'BOTH' },
  { code: 'AIR_CONDITIONING', label: 'Air conditioning', scope: 'ROOM' },
  { code: 'BALCONY', label: 'Balcony', scope: 'ROOM' },
  { code: 'SEA_VIEW', label: 'Sea view', scope: 'ROOM' },
  { code: 'CITY_VIEW', label: 'City view', scope: 'ROOM' },
  { code: 'KITCHENETTE', label: 'Kitchenette', scope: 'ROOM' },
  { code: 'MINIBAR', label: 'Minibar', scope: 'ROOM' },
  { code: 'IN_ROOM_SAFE', label: 'In-room safe', scope: 'ROOM' },
  { code: 'TV', label: 'Television', scope: 'ROOM' },
  { code: 'COFFEE_MAKER', label: 'Coffee and tea maker', scope: 'ROOM' },
  { code: 'BATHTUB', label: 'Bathtub', scope: 'ROOM' },
  { code: 'WORK_DESK', label: 'Work desk', scope: 'ROOM' },
] as const satisfies ReadonlyArray<{ code: string; label: string; scope: AmenityScope }>;
export type AmenityCode = (typeof AMENITY_CATALOGUE)[number]['code'];

export interface AmenitySelection { code: string; feeType: AmenityFeeType }

export interface RoomUsage {
  ratePlans: number
  activeRatePlans: number
  mappings: { mapped: number; pending: number; rejected: number }
}

export interface HotelRoomView {
  id: string
  code: string
  name: string
  maxAdults: number
  maxChildren: number
  maxOccupancy: number
  isActive: boolean
  bedding: RoomBedding
  amenities: AmenitySelection[] | null
  usage: RoomUsage
  /** Opaque. Send it back as `expectedToken`; a stale value is rejected. */
  concurrencyToken: string
  updatedAt: string
}

export interface HotelChildPolicyRow {
  contractId: string; contractCode: string; supplierName: string
  minAge: number; maxAge: number; extraBedAllowed: boolean
  /** Integer minor units as a string, with its ISO-4217 currency. */
  supplementMinor: string | null; currency: string | null
}

export interface HotelRoomsView {
  generatedAt: string
  hotelId: string
  hotelStatus: string
  rooms: HotelRoomView[]
  /** Contract child-age rules for this hotel (read-only). null when the API database role cannot read them. */
  childPolicies: HotelChildPolicyRow[] | null
  /** True when amenities could not be read (the grants have not been reviewed); rooms still load. */
  amenitiesAvailable: boolean
}

export interface RoomSave {
  idempotencyKey: string
  /** Required to change an existing room; omitted when creating. */
  expectedToken?: string
  reason?: string
  name?: string; code?: string; maxAdults?: number; maxChildren?: number; maxOccupancy?: number
  bedding?: { description?: string | null; beds?: Array<{ type: string; count: number }>; extraBed?: string }
  amenities?: AmenitySelection[]
}
export interface RoomArchive { idempotencyKey: string; expectedToken: string; reason: string }
export interface RoomSaved { room: HotelRoomView; auditRequestId: string; replayed: boolean }

export interface HotelAmenitiesView {
  generatedAt: string
  hotelId: string
  concurrencyToken: string
  catalogue: Array<{ code: string; label: string; scope: AmenityScope }>
  hotel: AmenitySelection[]
}
export interface HotelAmenitiesSave { idempotencyKey: string; expectedToken: string; amenities: AmenitySelection[] }
export interface HotelAmenitiesSaved { amenities: HotelAmenitiesView; auditRequestId: string; replayed: boolean }
