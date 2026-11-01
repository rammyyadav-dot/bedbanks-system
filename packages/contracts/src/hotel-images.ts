/** Hotel images (ADR 0027). Limits are enforced by the API and the database; the UI only mirrors them. */
export const HOTEL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type HotelImageType = (typeof HOTEL_IMAGE_TYPES)[number]
export const HOTEL_IMAGE_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPerHotel: 30,
  minWidth: 800, minHeight: 600, maxWidth: 8000, maxHeight: 8000,
  altTextMax: 200,
} as const

export interface HotelImageView {
  id: string
  contentType: HotelImageType
  bytes: number
  width: number
  height: number
  altText: string
  sortOrder: number
  isPrimary: boolean
  uploadedById: string
  createdAt: string
  /** API path (relative to /api/v1) that streams the image bytes for this tenant and hotel. */
  contentPath: string
}
export interface HotelImageList { hotelId: string; items: HotelImageView[]; limits: typeof HOTEL_IMAGE_LIMITS }
/** Fields left out are unchanged. `isPrimary: true` makes this the primary image (the previous one is cleared); it cannot be set to false directly. */
export interface HotelImageUpdate { altText?: string; sortOrder?: number; isPrimary?: true }
/** The complete new order: every image of the hotel exactly once, first to last. Applied atomically. */
export interface HotelImageReorder { imageIds: string[] }
export const HOTEL_IMAGE_ERROR_CODES = {
  unsupportedType: 'HOTEL_IMAGE_UNSUPPORTED_TYPE',
  tooLarge: 'HOTEL_IMAGE_TOO_LARGE',
  badDimensions: 'HOTEL_IMAGE_BAD_DIMENSIONS',
  duplicate: 'HOTEL_IMAGE_DUPLICATE',
  orderMismatch: 'HOTEL_IMAGE_ORDER_MISMATCH',
  limitReached: 'HOTEL_IMAGE_LIMIT_REACHED',
} as const
