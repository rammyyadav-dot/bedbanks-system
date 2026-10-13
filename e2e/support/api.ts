import { ORIGINS } from './config'
import { ACCOUNTS, isoDay, passwordFor, type AccountKey } from './helpers'

const API = `${ORIGINS.api}/api/v1`

export interface Reply { status: number; body: any; headers: Headers }

/** Origin each account's portal sends. The API only accepts credentialed writes from its own portals. */
const PORTAL_OF: Record<AccountKey, string> = {
  admin: ORIGINS.admin, restricted: ORIGINS.admin, agent: ORIGINS.agent, tenantB: ORIGINS.agent,
  supplierEditor: ORIGINS.supplier, supplierReader: ORIGINS.supplier, supplierBeta: ORIGINS.supplier, supplierRevoked: ORIGINS.supplier,
}

export async function call(path: string, init: { method?: string; cookie?: string; origin?: string; headers?: Record<string, string>; json?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.cookie) headers.cookie = init.cookie
  if (init.origin) headers.origin = init.origin
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${API}${path}`, { method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers }
}

export async function login(key: AccountKey): Promise<{ cookie: string; setCookie: string; reply: Reply }> {
  const reply = await call('/auth/login', { json: { email: ACCOUNTS[key], password: passwordFor(key) }, origin: PORTAL_OF[key] })
  const setCookie = reply.headers.get('set-cookie') ?? ''
  return { cookie: setCookie.split(';')[0], setCookie, reply }
}

export const offerSearchBody = (checkIn: string, checkOut: string) => ({
  destination: 'Dubai', destinationRef: { type: 'city', id: 'city:AE:dubai', countryCode: 'AE' }, checkIn, checkOut,
  rooms: 1, adults: 2, children: 0, childAges: [], roomStays: [{ adults: 2, children: [] }], nationality: 'IN', currency: 'AED', limit: 25,
})

/** The search window the fixtures sell: they are seeded 21 nights from today; the platform sells from about two weeks out. */
export const SELLABLE_STAY = () => ({ checkIn: isoDay(14), checkOut: isoDay(16) })
