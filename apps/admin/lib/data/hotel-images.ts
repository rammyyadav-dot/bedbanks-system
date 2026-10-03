// Hotel image API access (ADR 0027). The browser never talks to storage; the API checks permission, type, size and dimensions.
import { routes, type HotelImageList, type HotelImageUpdate } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'

const r = routes.adminHotelImages
const fill = (path: string, hotelId: string, imageId = '') => path.replace(':hotelId', encodeURIComponent(hotelId)).replace(':imageId', encodeURIComponent(imageId))

export const getHotelImages = (hotelId: string) => apiRequest<HotelImageList>(fill(r.images, hotelId))
/** The image itself is the request body; the alt text is a query parameter. */
export const uploadHotelImage = (hotelId: string, file: File, altText: string) =>
  apiRequestWithMeta<unknown>(`${fill(r.images, hotelId)}?altText=${encodeURIComponent(altText)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
export const updateHotelImage = (hotelId: string, imageId: string, body: HotelImageUpdate) =>
  apiRequestWithMeta<HotelImageList>(fill(r.image, hotelId, imageId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const deleteHotelImage = (hotelId: string, imageId: string) => apiRequestWithMeta<HotelImageList>(fill(r.image, hotelId, imageId), { method: 'DELETE' })
/** Same-origin URL for an <img>; the session cookie authorises it. */
export const hotelImageSrc = (contentPath: string) => `/api/v1${contentPath}`
