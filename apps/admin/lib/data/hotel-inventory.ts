// Inventory & Allotment API access (ADR 0030). Every change carries an idempotency key and the token of what the operator saw.
import {
  routes, type HotelInventorySummary, type InventoryPoolCreateRequest, type InventoryPoolMembersRequest, type InventoryPoolResult, type InventoryPoolUpdateRequest,
  type InventoryReleaseRequest, type InventoryReleaseResult, type InventoryPoolDetail, type PoolConsumptionReport, type PoolCapacityApplied, type PoolCapacityApply, type PoolCapacityEditRequest, type PoolNightDecision, type PoolNightRequestBody, type PoolNightRequestList, type PoolCapacityPreview,
} from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

const r = routes.adminHotelInventory
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const json = { 'Content-Type': 'application/json' }

export const getInventorySummary = (hotelId: string, p: { from?: string; days?: number } = {}) => apiRequest<HotelInventorySummary>(`${fill(r.summary, { hotelId })}${opsQuery(p)}`)
export const createInventoryPool = (hotelId: string, body: InventoryPoolCreateRequest) => apiRequestWithMeta<InventoryPoolResult>(fill(r.pools, { hotelId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const updateInventoryPool = (hotelId: string, poolId: string, body: InventoryPoolUpdateRequest) => apiRequestWithMeta<InventoryPoolResult>(fill(r.pool, { hotelId, poolId }), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const addInventoryPoolMembers = (hotelId: string, poolId: string, body: InventoryPoolMembersRequest) => apiRequestWithMeta<InventoryPoolResult>(fill(r.poolMembersAdd, { hotelId, poolId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const removeInventoryPoolMembers = (hotelId: string, poolId: string, body: InventoryPoolMembersRequest) => apiRequestWithMeta<InventoryPoolResult>(fill(r.poolMembersRemove, { hotelId, poolId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const setPlanRelease = (hotelId: string, ratePlanId: string, body: InventoryReleaseRequest) => apiRequestWithMeta<InventoryReleaseResult>(fill(r.planRelease, { hotelId, ratePlanId }), { method: 'PATCH', headers: json, body: JSON.stringify(body) })

// Pool detail, per-plan consumption and the capacity editor (ADR 0036). A preview writes nothing; an apply carries the preview's fingerprint, a reason and an idempotency key.
export const getPoolDetail = (hotelId: string, poolId: string, p: { from?: string; days?: number } = {}) => apiRequest<InventoryPoolDetail>(`${fill(r.pool, { hotelId, poolId })}${opsQuery(p)}`)
export const getPoolConsumption = (hotelId: string, poolId: string, p: { from?: string; days?: number } = {}) => apiRequest<PoolConsumptionReport>(`${fill(r.poolConsumption, { hotelId, poolId })}${opsQuery(p)}`)
export const previewPoolCapacity = (hotelId: string, poolId: string, body: PoolCapacityEditRequest) => apiRequest<PoolCapacityPreview>(fill(r.poolCapacityPreview, { hotelId, poolId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const applyPoolCapacity = (hotelId: string, poolId: string, body: PoolCapacityApply) => apiRequestWithMeta<PoolCapacityApplied>(fill(r.poolCapacityApply, { hotelId, poolId }), { method: 'POST', headers: json, body: JSON.stringify(body) })

// Requests to open new pool nights (ADR 0036 Amendment 3): recorded here, approved by a second person, applied by the database owner.
export const listPoolNightRequests = (hotelId: string, poolId: string) => apiRequest<PoolNightRequestList>(fill(r.poolNightRequests, { hotelId, poolId }))
export const requestPoolNights = (hotelId: string, poolId: string, body: PoolNightRequestBody) => apiRequest<PoolNightRequestList>(fill(r.poolNightRequests, { hotelId, poolId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const decidePoolNightRequest = (hotelId: string, poolId: string, approvalId: string, decision: 'approve' | 'reject', body: PoolNightDecision) =>
  apiRequest<PoolNightRequestList>(fill(decision === 'approve' ? r.poolNightRequestApprove : r.poolNightRequestReject, { hotelId, poolId, approvalId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const cancelPoolNightRequest = (hotelId: string, poolId: string, approvalId: string) => apiRequest<PoolNightRequestList>(fill(r.poolNightRequestCancel, { hotelId, poolId, approvalId }), { method: 'POST', headers: json, body: '{}' })
