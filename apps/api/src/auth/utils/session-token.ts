import { randomBytes, createHash } from 'crypto';

const TOKEN_BYTES = 32; // 256 bits of entropy

/**
 * Generates the raw session token given to the browser (in the
 * HttpOnly cookie) — never stored anywhere. 32 random bytes,
 * hex-encoded, from Node's CSPRNG.
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Deterministic hash of a raw token, for lookup and storage. A plain
 * SHA-256 (no HMAC/secret) is sufficient here specifically because the
 * input already has 256 bits of CSPRNG entropy — an attacker who only
 * has the database can't feasibly brute-force which raw token produced
 * a given hash. This is different from password hashing (where bcrypt
 * exists because passwords are low-entropy and guessable); don't reuse
 * bcrypt for this, and don't reuse this scheme for passwords.
 */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
