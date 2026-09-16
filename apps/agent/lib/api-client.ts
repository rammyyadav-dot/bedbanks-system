export type AgentIdentity = {
  user: { id: string; email: string; name: string | null; status: 'ACTIVE' | 'SUSPENDED' }
  memberships: Array<{ tenantId: string; tenantName: string; role: string }>
}

const apiBase = process.env.NEXT_PUBLIC_AGENT_API_URL ?? 'http://localhost:3001/api/v1'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? 'Request failed')
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
  return request<{ status: 'available' | 'provider_unavailable' }>('/agent/search/status', { method: 'POST', headers: { 'x-fbeds-tenant-id': tenantId }, body: JSON.stringify({ destination: 'status', checkIn: '2026-09-16', checkOut: '2026-09-17', rooms: 1, adults: 1, children: 0, nationality: 'US', currency: 'USD' }) })
}
