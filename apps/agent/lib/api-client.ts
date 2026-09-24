import { agentApiBase } from './api-config.mjs'

export type AgentIdentity = {
  user: { id: string; email: string; name: string | null; status: 'ACTIVE' | 'SUSPENDED' }
  memberships: Array<{ tenantId: string; tenantName: string; role: string }>
}

const apiBase = agentApiBase

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) throw new Error('Session expired')
    if (response.status === 403) throw new Error('Access denied')
    throw new Error('Request failed')
  }
  return body?.data ?? body
}

export function login(email: string, password: string) {
  return request<AgentIdentity>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function getAgentContext() {
  return request<{ user: AgentIdentity['user']; memberships: AgentIdentity['memberships']; capabilities: string[] }>('/agent/context')
}

export function logout() {
  return request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' })
}

export function getFinanceSummary(tenantId: string) {
  return request<{ status: string; availableCredit: number | null }>(`/agent/finance/summary`, { headers: { 'x-fbeds-tenant-id': tenantId } })
}

export function getSearchStatus(tenantId: string) {
  const checkIn = new Date().toISOString().slice(0, 10)
  const checkOut = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  return request<{ status: 'available' | 'provider_unavailable' }>('/agent/search/status', { method: 'POST',
    headers: { 'x-fbeds-tenant-id': tenantId },
    body: JSON.stringify({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 1,
      children: 0, childAges: [], nationality: 'IN', currency: 'AED' }) })
}
