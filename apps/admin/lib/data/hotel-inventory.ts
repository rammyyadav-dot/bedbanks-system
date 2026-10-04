// Inventory & Allotment API access (ADR 0030). Every change carries an idempotency key and the token of what the operator saw.
import {
  routes, type HotelInventorySummary, type InventoryPoolCreateRequest, type InventoryPoolMembersRequest, type InventoryPoolResult, type InventoryPoolUpdateRequest,
  type InventoryReleaseRequest, type InventoryReleaseResult,
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
