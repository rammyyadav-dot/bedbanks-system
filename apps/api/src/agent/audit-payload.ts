const BLOCKED_KEYS = new Set([
  'password', 'passwordhash', 'token', 'tokenhash', 'authorization', 'cookie',
  'cardnumber', 'cvv', 'pan', 'suppliercredential', 'supplierpassword', 'apikey', 'secret', 'accesstoken', 'bearertoken',
  'email', 'phone', 'guestemail', 'guestphone', 'passportnumber', 'passport',
])

type AuditValue = string | number | boolean | null | AuditValue[] | { [key: string]: AuditValue }

/**
 * Keeps audit payloads operationally useful without persisting credentials,
 * payment data, session material or guest PII. Unknown object values are
 * recursively inspected; blocked keys are redacted rather than omitted so a
 * security review can see that sensitive input was received.
 */
export function sanitizeAuditPayload(input: Record<string, unknown>): Record<string, AuditValue> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, sanitizeValue(key, value)]))
}

function sanitizeValue(key: string, value: unknown): AuditValue {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (BLOCKED_KEYS.has(normalizedKey)) return '[REDACTED]'
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item))
  if (typeof value === 'object') return sanitizeAuditPayload(value as Record<string, unknown>)
  return String(value)
}
