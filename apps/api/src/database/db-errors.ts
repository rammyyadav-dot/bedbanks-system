/**
 * PostgreSQL insufficient_privilege (SQLSTATE 42501) as it reaches the application through Prisma, either as the driver
 * code in `meta.code` (raw queries) or only in the message (model queries). It is a role-grant mismatch, not a caller decision.
 */
const PERMISSION_DENIED_MESSAGE = /permission denied for (table|sequence|function|schema|relation|view)\b/

export function isDatabasePermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const meta = 'meta' in error ? (error as { meta?: { code?: string } }).meta : undefined
  if (meta?.code === '42501') return true
  return error instanceof Error && PERMISSION_DENIED_MESSAGE.test(error.message)
}

/** The SQLSTATE or Prisma code only: safe to log, never the message, which can name tables or carry values. */
export function databaseErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown'
  const meta = 'meta' in error ? (error as { meta?: { code?: unknown } }).meta : undefined
  if (typeof meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,12}$/.test(code) ? code : isDatabasePermissionDenied(error) ? '42501' : 'unknown'
}
