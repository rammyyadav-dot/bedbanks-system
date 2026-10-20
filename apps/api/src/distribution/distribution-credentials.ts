import { createHash, randomBytes } from 'crypto'
import { BlockList, isIP } from 'net'
import { DISTRIBUTION_API_SCOPES, type DistributionWireScope } from '@bedbanks/contracts'

/**
 * Partner credential formats (ADR 0075, amendments 3-4). Pure functions: no I/O, nothing logged.
 *
 *   API key        fbk_<keyId>_<secret>     keyId: 20 x [a-z0-9]; secret: 32 random bytes, base64url (43 characters)
 *   OAuth client   client_id = <keyId>, client_secret = <secret>
 *   Access token   fbt_<43 base64url characters>
 *
 * The database stores SHA-256 hex of the secret (credentials) or of the whole token string (tokens), and compares inside its
 * SECURITY DEFINER functions. Shapes are checked before any hashing or query, so malformed input never reaches the database.
 */
export const API_KEY_PREFIX = 'fbk_'
export const ACCESS_TOKEN_PREFIX = 'fbt_'
const KEY_ID = /^[a-z0-9]{20}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const API_KEY = /^fbk_([a-z0-9]{20})_([A-Za-z0-9_-]{43})$/
const ACCESS_TOKEN = /^fbt_[A-Za-z0-9_-]{43}$/
const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** The database enum, in its own order. */
export type DistributionDbScope = 'SEARCH' | 'CHECKRATE' | 'BOOK' | 'CANCEL' | 'BOOKINGS_READ'
const DB_SCOPES: readonly DistributionDbScope[] = ['SEARCH', 'CHECKRATE', 'BOOK', 'CANCEL', 'BOOKINGS_READ']
const TO_WIRE: Record<DistributionDbScope, DistributionWireScope> = { SEARCH: 'search', CHECKRATE: 'checkrate', BOOK: 'book', CANCEL: 'cancel', BOOKINGS_READ: 'bookings:read' }
const FROM_WIRE = new Map(Object.entries(TO_WIRE).map(([db, wire]) => [wire, db as DistributionDbScope]))

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export function parseApiKey(value: string): { keyId: string; secret: string } | null {
  const match = API_KEY.exec(value)
  return match ? { keyId: match[1], secret: match[2] } : null
}

export function parseClientCredentials(clientId: unknown, clientSecret: unknown): { keyId: string; secret: string } | null {
  return typeof clientId === 'string' && typeof clientSecret === 'string' && KEY_ID.test(clientId) && SECRET.test(clientSecret) ? { keyId: clientId, secret: clientSecret } : null
}

export const isAccessToken = (value: string): boolean => ACCESS_TOKEN.test(value)

export function newAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** A new credential, for the operator flow that creates one (shown once) and for tests. Only `secretHash` is ever stored. */
export function newCredentialMaterial(): { keyId: string; secret: string; apiKey: string; secretHash: string } {
  const keyId = Array.from(randomBytes(20), (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('')
  const secret = randomBytes(32).toString('base64url')
  return { keyId, secret, apiKey: `${API_KEY_PREFIX}${keyId}_${secret}`, secretHash: sha256Hex(secret) }
}

export function toWireScopes(scopes: readonly string[]): DistributionWireScope[] {
  return DB_SCOPES.filter((s) => scopes.includes(s)).map((s) => TO_WIRE[s])
}

/** OAuth `scope` parameter: space-separated wire names, each known. Omitted or blank means "all of the client's". */
export function parseScopeParam(scope: unknown): { ok: true; scopes: DistributionDbScope[] } | { ok: false } {
  if (scope === undefined || (typeof scope === 'string' && scope.trim() === '')) return { ok: true, scopes: [] }
  if (typeof scope !== 'string' || scope.length > 200) return { ok: false }
  const scopes: DistributionDbScope[] = []
  for (const name of scope.trim().split(/ +/)) {
    const db = FROM_WIRE.get(name as DistributionWireScope)
    if (!db) return { ok: false }
    if (!scopes.includes(db)) scopes.push(db)
  }
  return { ok: true, scopes }
}

/** Wire names stay in step with the contract. */
export const WIRE_SCOPES: readonly DistributionWireScope[] = DISTRIBUTION_API_SCOPES

/**
 * Whether `ip` is inside one of the client's CIDR blocks. An empty allowlist allows any address. An address that cannot be parsed, or an entry
 * that cannot (the database already refuses those), never matches: the result can only fail closed.
 */
export function ipAllowed(ip: string | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  if (!ip) return false
  const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
  const family = isIP(address)
  if (family === 0) return false
  const blocks = new BlockList()
  for (const entry of allowlist) {
    const [network, bits] = entry.split('/')
    const type = isIP(network) === 6 ? 'ipv6' : isIP(network) === 4 ? 'ipv4' : null
    const prefix = bits === undefined ? (type === 'ipv6' ? 128 : 32) : Number(bits)
    if (!type || !Number.isInteger(prefix)) continue
    try { blocks.addSubnet(network, prefix, type) } catch { /* an invalid entry never matches */ }
  }
  return blocks.check(address, family === 6 ? 'ipv6' : 'ipv4')
}
