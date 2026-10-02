import type { DestinationResolution } from '@bedbanks/domain'
import { routes } from '@bedbanks/contracts'
import { agentApiBase } from './api-config.mjs'

export type SearchFacets = { boards: { id: string; name: string }[]; propertyTypes: string[] }

async function readData(path: string, tenantId: string): Promise<unknown> {
  if (!tenantId) return null
  const response = await fetch(`${agentApiBase}${path}`, { credentials: 'include', headers: { 'x-fbeds-tenant-id': tenantId } })
  if (!response.ok) return null
  const envelope: unknown = await response.json()
  return typeof envelope === 'object' && envelope !== null && 'data' in envelope ? envelope.data : envelope
}

export async function fetchDestinations(query: string, tenantId: string): Promise<DestinationResolution[]> {
  try {
    const data = await readData(`${routes.agent.destinations}?q=${encodeURIComponent(query.trim())}`, tenantId)
    if (!data || typeof data !== 'object' || !('results' in data) || !Array.isArray(data.results)) return []
    return data.results.filter(isResolution)
  } catch {
    return []
  }
}

export async function fetchFacets(tenantId: string): Promise<SearchFacets> {
  try {
    const data = await readData(routes.agent.searchFacets, tenantId)
    if (!data || typeof data !== 'object') return { boards: [], propertyTypes: [] }
    const row = data as { boards?: unknown; propertyTypes?: unknown }
    const boards = Array.isArray(row.boards) ? row.boards.filter((item): item is { id: string; name: string } => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { name?: unknown }).name === 'string') : []
    const propertyTypes = Array.isArray(row.propertyTypes) ? row.propertyTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
    return { boards, propertyTypes }
  } catch {
    return { boards: [], propertyTypes: [] }
  }
}

function isResolution(value: unknown): value is DestinationResolution {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (row.type === 'city') return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.countryCode === 'string'
  return row.type === 'hotel' && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.cityId === 'string' && typeof row.cityName === 'string' && typeof row.countryCode === 'string'
}
