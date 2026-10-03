// Hotel rooms and amenities API access (ADR 0021, stage 2). Rooms are archived, never deleted.
import { routes, type HotelAmenitiesSave, type HotelAmenitiesSaved, type HotelAmenitiesView, type HotelRoomsView, type RoomArchive, type RoomSave, type RoomSaved } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'

const r = routes.adminHotelSetup
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const json = { 'Content-Type': 'application/json' }

export const getHotelRooms = (hotelId: string) => apiRequest<HotelRoomsView>(fill(r.rooms, { hotelId }))
export const createHotelRoom = (hotelId: string, body: RoomSave) => apiRequestWithMeta<RoomSaved>(fill(r.rooms, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const updateHotelRoom = (hotelId: string, roomId: string, body: RoomSave) => apiRequestWithMeta<RoomSaved>(fill(r.room, { hotelId, roomId }), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const archiveHotelRoom = (hotelId: string, roomId: string, body: RoomArchive) => apiRequestWithMeta<RoomSaved>(fill(r.roomArchive, { hotelId, roomId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const restoreHotelRoom = (hotelId: string, roomId: string, body: RoomArchive) => apiRequestWithMeta<RoomSaved>(fill(r.roomRestore, { hotelId, roomId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const getHotelAmenities = (hotelId: string) => apiRequest<HotelAmenitiesView>(fill(r.amenities, { hotelId }))
export const saveHotelAmenities = (hotelId: string, body: HotelAmenitiesSave) => apiRequestWithMeta<HotelAmenitiesSaved>(fill(r.amenities, { hotelId }), { method: 'PUT', headers: json, body: JSON.stringify(body) })
