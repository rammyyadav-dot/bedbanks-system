import { agentApiBase } from './api-config.mjs'
import { defaultSearchStay } from './stay-dates.mjs'

export type AgentIdentity = {
  user: { id: string; email: string; name: string | null; status: 'ACTIVE' | 'SUSPENDED' }
  memberships: Array<{ tenantId: string; tenantName: string; role: string }>
  /** Server context only. True solely when the API sends boolean true. Never a booking permission. */
  bookingEnabled: boolean
  /** Currencies the server enables (ADR 0029). Fails closed to AED when the server sends nothing usable. */
  settlementCurrencies: string[]
}

/** Fail closed. Only an explicit boolean true from agent context enables the booking UI. */
export function bookingEnabledFromContext(value: unknown): boolean {
  return value === true
}

export function settlementCurrenciesFromContext(value: unknown): string[] {
  const list = Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c)) : []
  return list.length > 0 ? [...new Set(list)] : ['AED']
}

export function agentSession(identity: { user: AgentIdentity['user']; memberships: AgentIdentity['memberships'] }, bookingEnabled: unknown, settlementCurrencies?: unknown): AgentIdentity {
  return { user: identity.user, memberships: identity.memberships, bookingEnabled: bookingEnabledFromContext(bookingEnabled), settlementCurrencies: settlementCurrenciesFromContext(settlementCurrencies) }
}

const apiBase = agentApiBase

/** availableCredit is an integer minor-unit amount serialised as a string, in `currency`. */
export type FinanceSummary = { status: string; currency: string; availableCredit: string | null; creditLimit?: string | null }

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

export async function login(email: string, password: string) {
  try {
    return await request<AgentIdentity>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  } catch (error) {
    if (error instanceof Error && error.message === 'Session expired') throw new Error('Invalid credentials')
    throw error
  }
}

export async function getAgentContext() {
  const context = await request<{ user: AgentIdentity['user']; memberships: AgentIdentity['memberships']; capabilities: string[]; bookingEnabled?: unknown; settlementCurrencies?: unknown }>('/agent/context')
  return { ...context, bookingEnabled: bookingEnabledFromContext(context.bookingEnabled), settlementCurrencies: settlementCurrenciesFromContext(context.settlementCurrencies) }
}

export function logout() {
  return request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' })
}

export function getFinanceSummary(tenantId: string) {
  return request<FinanceSummary>(`/agent/finance/summary`, { headers: { 'x-fbeds-tenant-id': tenantId } })
}

export function getSearchStatus(tenantId: string) {
  const stay = defaultSearchStay(Date.now(), 1)
  const checkIn = stay.checkIn
  const checkOut = stay.checkOut
  return request<{ status: 'not_checked' | 'provider_unavailable' }>('/agent/search/status', { method: 'POST',
    headers: { 'x-fbeds-tenant-id': tenantId },
    body: JSON.stringify({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 1,
      children: 0, childAges: [], nationality: 'IN', currency: 'AED' }) })
}
