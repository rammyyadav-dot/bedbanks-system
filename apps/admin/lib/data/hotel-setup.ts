// Hotel Setup API access (ADR 0021). The browser never talks to the database; the API validates, gates publication and audits.
import { routes, type HotelOwnerCandidate, type HotelPublicationDecision, type HotelPublicationRequest, type HotelPublicationResult, type HotelSetupSave, type HotelSetupSaved, type HotelSetupStatusChange, type HotelSetupView } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'

const r = routes.adminHotelSetup
const fill = (path: string, hotelId: string) => path.replace(':hotelId', encodeURIComponent(hotelId))
const json = { 'Content-Type': 'application/json' }

export const getHotelSetup = (hotelId: string) => apiRequest<HotelSetupView>(fill(r.setup, hotelId))
export const saveHotelSetup = (hotelId: string, body: HotelSetupSave) => apiRequestWithMeta<HotelSetupSaved>(fill(r.setup, hotelId), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const changeHotelStatus = (hotelId: string, body: HotelSetupStatusChange) => apiRequestWithMeta<HotelSetupSaved>(fill(r.status, hotelId), { method: 'POST', headers: json, body: JSON.stringify(body) })

export const getOwnerCandidates = (hotelId: string, search: string) => apiRequest<HotelOwnerCandidate[]>(`${fill(r.ownerCandidates, hotelId)}${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`)

const fillApproval = (path: string, hotelId: string, approvalId: string) => fill(path, hotelId).replace(':approvalId', encodeURIComponent(approvalId))
const post = <T>(path: string, body: unknown) => apiRequestWithMeta<T>(path, { method: 'POST', headers: json, body: JSON.stringify(body ?? {}) })
export const requestHotelPublication = (hotelId: string, body: HotelPublicationRequest) => post<HotelPublicationResult>(fill(r.publicationRequest, hotelId), body)
export const approveHotelPublication = (hotelId: string, approvalId: string, body: HotelPublicationDecision) => post<HotelPublicationResult>(fillApproval(r.publicationApprove, hotelId, approvalId), body)
export const rejectHotelPublication = (hotelId: string, approvalId: string, body: HotelPublicationDecision) => post<HotelPublicationResult>(fillApproval(r.publicationReject, hotelId, approvalId), body)
export const cancelHotelPublication = (hotelId: string, approvalId: string) => post<HotelPublicationResult>(fillApproval(r.publicationCancel, hotelId, approvalId), {})
export const executeHotelPublication = (hotelId: string, approvalId: string) => post<HotelPublicationResult>(fillApproval(r.publicationExecute, hotelId, approvalId), {})

export const getHotelLocationOptions = (countryCode: string) => apiRequest<import('@bedbanks/contracts').HotelLocationOptions>(`${r.locationOptions}${/^[A-Z]{2}$/.test(countryCode) ? `?countryCode=${encodeURIComponent(countryCode)}` : ''}`)
