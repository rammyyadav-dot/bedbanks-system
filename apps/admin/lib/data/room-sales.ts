import {
  routes, type AllocationBoard, type AllocationEditRequest, type AllocationEditResult, type RoomSalesCalendar, type RoomSalesCommitRequest,
  type RoomSalesCommitResult, type RoomSalesPreview, type RoomSalesPreviewRequest, type SalesEligibilityRequest, type SalesEligibilityResult,
  type SalesHistoryEntry,
} from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

const r = routes.adminHotelInventory
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const json = { 'Content-Type': 'application/json' }
const manage = 'supply.availability.manage'

export const getSalesCalendar = (hotelId: string, query: { from?: string; days?: number; poolId?: string; ratePlanId?: string; channel?: string; market?: string; contractId?: string }) =>
  apiRequest<RoomSalesCalendar>(`${fill(r.salesCalendar, { hotelId })}${opsQuery(query)}`)
export const getSalesHistory = (hotelId: string, query: { roomTypeId: string; stayDate: string }) => apiRequest<SalesHistoryEntry[]>(`${fill(r.salesHistory, { hotelId })}${opsQuery(query)}`)
export const previewSales = (hotelId: string, body: RoomSalesPreviewRequest) => apiRequest<RoomSalesPreview>(fill(r.salesPreview, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body), permission: manage })
export const commitSales = (hotelId: string, body: RoomSalesCommitRequest) => apiRequestWithMeta<RoomSalesCommitResult>(fill(r.salesCommit, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body), permission: manage })
export const checkSalesEligibility = (hotelId: string, body: SalesEligibilityRequest) => apiRequest<SalesEligibilityResult>(fill(r.salesEligibility, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const getAllocationBoard = (hotelId: string, query: { from?: string; days?: number }) => apiRequest<AllocationBoard>(`${fill(r.allocation, { hotelId })}${opsQuery(query)}`)
export const applyAllocation = (hotelId: string, body: AllocationEditRequest) => apiRequestWithMeta<AllocationEditResult>(fill(r.allocationApply, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body), permission: manage })
export const releaseAllocation = (hotelId: string, body: { poolId: string; from: string; to: string; reason: string; idempotencyKey: string; expectedFingerprint: string }) =>
  apiRequestWithMeta<AllocationEditResult>(fill(r.allocationRelease, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body), permission: manage })
export const deliverSalesDistribution = (hotelId: string, jobId: string, forceFailure = false) =>
  apiRequest<{ id: string; state: string; attempts: number; simulated: true; label: string; note: string }>(fill(r.salesDistributionDeliver, { hotelId, jobId }), { method: 'POST', headers: json, body: JSON.stringify({ forceFailure }), permission: manage })
