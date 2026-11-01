// Fixed, non-default ports so the suite never collides with a developer's running dev servers (3000-3003).
export const PORTS = { agent: 3900, admin: 3901, api: 3902, supplier: 3903 } as const
export const ORIGINS = {
  agent: `http://localhost:${PORTS.agent}`,
  admin: `http://localhost:${PORTS.admin}`,
  supplier: `http://localhost:${PORTS.supplier}`,
  api: `http://127.0.0.1:${PORTS.api}`,
} as const

/** The ONLY database this suite will create, drop or write. It is the name the preview-fixture tool itself insists on. */
export const DATABASE = 'fbeds_preview_xt'
export const RUNTIME_LOGIN = 'fbeds_api_login'

/** A superuser/owner connection to the maintenance database of a LOOPBACK PostgreSQL. Override with E2E_PG_ADMIN_URL. */
export function pgAdminUrl(): URL {
  const url = new URL(process.env.E2E_PG_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres')
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error(`E2E refuses a non-loopback PostgreSQL host "${url.hostname}": this suite drops and recreates ${DATABASE}.`)
  }
  return url
}
export const urlFor = (base: URL, database: string, user?: string, password?: string): string => {
  const u = new URL(base.toString())
  u.pathname = `/${database}`
  u.search = '?schema=public'
  if (user) u.username = user
  if (password !== undefined) u.password = password
  return u.toString()
}
