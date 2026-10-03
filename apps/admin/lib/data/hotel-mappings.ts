// Supplier mapping governance access for one hotel (ADR 0021, stage 3). The existing /supply/mappings API owns every rule:
// nothing is approved automatically, a room cannot be approved before its hotel mapping, and conflicts are rejected with a code.
import { apiRequestWithMeta } from '../api/client'

const base = '/supply/mappings/hotels'
const json = { 'Content-Type': 'application/json' }
const post = (body?: unknown) => ({ method: 'POST', headers: json, body: JSON.stringify(body ?? {}) })

export type MappingDecision = 'approve' | 'reject' | 'reopen'

export const createSupplierHotelMapping = (body: { supplierId: string; hotelId: string; supplierHotelId: string; confidence?: number; sourceMetadata?: { source: string } }) => apiRequestWithMeta<{ id: string }>(base, post(body))
export const decideSupplierHotelMapping = (mappingId: string, decision: MappingDecision, reason: string) => apiRequestWithMeta<{ id: string; status: string }>(`${base}/${encodeURIComponent(mappingId)}/${decision}`, post({ reason }))
export const createSupplierRoomMapping = (mappingId: string, body: { supplierRoomId: string; roomTypeId: string; confidence?: number; sourceMetadata?: { source: string } }) => apiRequestWithMeta<{ id: string }>(`${base}/${encodeURIComponent(mappingId)}/rooms`, post(body))
export const decideSupplierRoomMapping = (mappingId: string, roomMappingId: string, decision: MappingDecision, reason: string) => apiRequestWithMeta<{ id: string; status: string }>(`${base}/${encodeURIComponent(mappingId)}/rooms/${encodeURIComponent(roomMappingId)}/${decision}`, post({ reason }))
