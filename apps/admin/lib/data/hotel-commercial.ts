// Hotel commercial operations API access. Read-only; no mock or fallback data lives here.
import {
  routes, type AuditEventView, type ExceptionsPage, type HotelCalendar, type HotelDistribution, type HotelCommercial360, type HotelCommercialPage, type HotelCommercialSummary,
  type HotelContractsView, type HotelMappingsView, type Paged, type SellabilityInspection,
} from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const ops = routes.adminOperations
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)

export const getHotelsCommercial = (p: Params) => apiRequest<HotelCommercialPage>(`${ops.hotels}${opsQuery(p)}`)
export const getHotelsSummary = (p: Params = {}) => apiRequest<HotelCommercialSummary>(`${ops.hotelsSummary}${opsQuery(p)}`)
export const getHotel360 = (hotelId: string, p: Params = {}) => apiRequest<HotelCommercial360>(`${fill(ops.hotel, { hotelId })}${opsQuery(p)}`)
export const getHotelContracts = (hotelId: string, p: Params = {}) => apiRequest<HotelContractsView>(`${fill(ops.hotelContracts, { hotelId })}${opsQuery(p)}`)
export const getHotelMappings = (hotelId: string) => apiRequest<HotelMappingsView>(fill(ops.hotelMappings, { hotelId }))
export const getHotelCalendar = (hotelId: string, p: Params) => apiRequest<HotelCalendar>(`${fill(ops.hotelCalendar, { hotelId })}${opsQuery(p)}`)
export const inspectHotelSellability = (hotelId: string, p: Params) => apiRequest<SellabilityInspection>(`${fill(ops.hotelSellability, { hotelId })}${opsQuery(p)}`)
export const getHotelDistribution = (hotelId: string, p: Params = {}) => apiRequest<HotelDistribution>(`${fill(ops.hotelDistribution, { hotelId })}${opsQuery(p)}`)
export const getHotelAudit = (hotelId: string, p: Params) => apiRequest<Paged<AuditEventView>>(`${fill(ops.hotelAudit, { hotelId })}${opsQuery(p)}`)
export const getCommercialExceptions = (p: Params) => apiRequest<ExceptionsPage>(`${ops.exceptions}${opsQuery(p)}`)
