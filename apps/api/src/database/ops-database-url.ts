const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export interface OpsDatabaseTarget {
  url: string
  host: string
  database: string
  pooled: boolean
  local: boolean
}

/**
 * Parses an owner connection string for operational tooling. Never includes the
 * input in an error. Removes channel_binding (unsupported by the Prisma engine)
 * and requires sslmode for non-local hosts.
 */
export function normalizeOpsDatabaseUrl(raw: string | undefined): OpsDatabaseTarget {
  if (!raw) throw new Error('Database URL is not set')
  let parsed: URL
  try { parsed = new URL(raw.trim()) } catch { throw new Error('Database URL is not a valid URL') }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error('Database URL must use the postgresql scheme')
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!parsed.hostname || !database) throw new Error('Database URL must include a host and database name')
  parsed.searchParams.delete('channel_binding')
  const local = LOCAL_HOSTS.has(parsed.hostname)
  if (!local && !parsed.searchParams.has('sslmode')) parsed.searchParams.set('sslmode', 'require')
  return { url: parsed.toString(), host: parsed.hostname, database, pooled: parsed.hostname.includes('-pooler'), local }
}

export function withCredentials(url: string, username: string, password: string): string {
  const parsed = new URL(url)
  parsed.username = username
  parsed.password = password
  return parsed.toString()
}
