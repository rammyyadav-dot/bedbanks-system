import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Server-to-server request signing for the lead receiver. No signing mechanism existed in the
 * repository, so this defines one: HMAC-SHA256 over `${timestamp}.${nonce}.${rawBody}` with a
 * shared server-only secret. The receiver MUST run verifyLeadRequest (or equivalent) with a
 * nonce store shared by all of its instances; an in-memory store only protects one process.
 */
export const SIGNATURE_PREFIX = 'v1='
export const MAX_CLOCK_SKEW_SECONDS = 300
export const MIN_SECRET_LENGTH = 32

export type SignedHeaders = { 'x-fbeds-timestamp': string; 'x-fbeds-nonce': string; 'x-fbeds-signature': string }

function mac(secret: string, timestamp: string, nonce: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest()
}

export function signLeadRequest(secret: string, body: string, options: { nowSeconds?: number; nonce?: string } = {}): SignedHeaders {
  const timestamp = String(options.nowSeconds ?? Math.floor(Date.now() / 1000))
  const nonce = options.nonce ?? randomBytes(16).toString('hex')
  return { 'x-fbeds-timestamp': timestamp, 'x-fbeds-nonce': nonce, 'x-fbeds-signature': SIGNATURE_PREFIX + mac(secret, timestamp, nonce, body).toString('hex') }
}

/** Returns true the first time a nonce is claimed within its ttl. Production stores must be shared and atomic. */
export interface NonceStore { claim(nonce: string, ttlSeconds: number, nowSeconds: number): boolean | Promise<boolean> }

export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>()
  claim(nonce: string, ttlSeconds: number, nowSeconds: number): boolean {
    for (const [key, expires] of this.seen) if (expires <= nowSeconds) this.seen.delete(key)
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, nowSeconds + ttlSeconds)
    return true
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'signature' | 'replay' }

export async function verifyLeadRequest(input: {
  secret: string
  rawBody: string
  headers: Partial<Record<keyof SignedHeaders, string | null | undefined>>
  nonceStore: NonceStore
  nowSeconds?: number
  toleranceSeconds?: number
}): Promise<VerifyResult> {
  const timestamp = input.headers['x-fbeds-timestamp']
  const nonce = input.headers['x-fbeds-nonce']
  const signature = input.headers['x-fbeds-signature']
  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing' }
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(nonce) || !signature.startsWith(SIGNATURE_PREFIX) || !/^[0-9a-f]{64}$/.test(signature.slice(SIGNATURE_PREFIX.length))) return { ok: false, reason: 'malformed' }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = input.toleranceSeconds ?? MAX_CLOCK_SKEW_SECONDS
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: 'expired' }
  const expected = mac(input.secret, timestamp, nonce, input.rawBody)
  const provided = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: 'signature' }
  // Claim only after the signature is valid so unauthenticated callers cannot burn nonces.
  if (!(await input.nonceStore.claim(nonce, tolerance * 2, now))) return { ok: false, reason: 'replay' }
  return { ok: true }
}
