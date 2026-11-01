// Quick Update API access (ADR 0021, stage 5). Preview is evidence; apply re-validates on the server.
import { routes, type QuickUpdateApplied, type QuickUpdateApply, type QuickUpdatePreview, type QuickUpdateRequest } from '@bedbanks/contracts'
import { apiRequestWithMeta } from '../api/client'

const r = routes.adminHotelSetup
const fill = (path: string, hotelId: string) => path.replace(':hotelId', encodeURIComponent(hotelId))
const json = { 'Content-Type': 'application/json' }

export const previewQuickUpdate = (hotelId: string, body: QuickUpdateRequest) => apiRequestWithMeta<QuickUpdatePreview>(fill(r.quickUpdatePreview, hotelId), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const applyQuickUpdate = (hotelId: string, body: QuickUpdateApply) => apiRequestWithMeta<QuickUpdateApplied>(fill(r.quickUpdateApply, hotelId), { method: 'POST', headers: json, body: JSON.stringify(body) })
