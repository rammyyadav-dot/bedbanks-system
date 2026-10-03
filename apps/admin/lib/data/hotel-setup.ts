// Hotel Setup API access (ADR 0021). The browser never talks to the database; the API validates, gates publication and audits.
import { routes, type HotelSetupSave, type HotelSetupSaved, type HotelSetupStatusChange, type HotelSetupView } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'

const r = routes.adminHotelSetup
const fill = (path: string, hotelId: string) => path.replace(':hotelId', encodeURIComponent(hotelId))
const json = { 'Content-Type': 'application/json' }

export const getHotelSetup = (hotelId: string) => apiRequest<HotelSetupView>(fill(r.setup, hotelId))
export const saveHotelSetup = (hotelId: string, body: HotelSetupSave) => apiRequestWithMeta<HotelSetupSaved>(fill(r.setup, hotelId), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const changeHotelStatus = (hotelId: string, body: HotelSetupStatusChange) => apiRequestWithMeta<HotelSetupSaved>(fill(r.status, hotelId), { method: 'POST', headers: json, body: JSON.stringify(body) })
