import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

export const releaseSha = '5c19dee520f2b41d8c7226ca6fd93a0e1d238cb9'
export const pending = [
  '202609230001_platform_role_management_permissions',
  '202609230001_supplier_mapping_governance',
  '202609250001_booking_concurrency_foundation',
  '202609260001_authoritative_rate_amount_semantics',
  '202609270001_supplier_admin_permissions',
]
export function requireCheck(condition, code) {
  if (!condition) throw new Error(code)
}
export function validateTarget(rawUrl, rawTarget, now = Date.now()) {
  requireCheck(Boolean(rawUrl && rawTarget), 'CLONE_SECRETS_MISSING')
  let url, target
  try { url = new URL(rawUrl); target = JSON.parse(rawTarget) } catch { throw new Error('CLONE_CONFIG_INVALID') }
  requireCheck(target && typeof target === 'object', 'CLONE_CONFIG_INVALID')
  requireCheck(target.releaseSha === releaseSha, 'RELEASE_SHA_MISMATCH')
  requireCheck(/^br-[a-z0-9-]+$/.test(target.branchId || '') && /^br-[a-z0-9-]+$/.test(target.parentBranchId || ''), 'BRANCH_ID_INVALID')
  requireCheck(target.branchId !== target.parentBranchId && target.primary === false && target.default === false, 'TARGET_NOT_DISPOSABLE_CLONE')
  requireCheck(/^cert-prod-schema-compat-/.test(target.branchName || ''), 'CLONE_NAME_INVALID')
  requireCheck(/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(target.hostname || '') && !target.hostname.includes('-pooler.'), 'DIRECT_ENDPOINT_REQUIRED')
  requireCheck(Array.isArray(target.productionHostnames) && target.productionHostnames.length > 0 && target.productionHostnames.every(h => typeof h === 'string' && h.length > 0), 'PRODUCTION_DENYLIST_REQUIRED')
  const normalize = host => host.replace('-pooler.', '.')
  requireCheck(!target.productionHostnames.some(h => normalize(h) === normalize(target.hostname)), 'PRODUCTION_TARGET_REJECTED')
  requireCheck(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === target.hostname && (!url.port || url.port === '5432'), 'CONNECTION_TARGET_MISMATCH')
  requireCheck(url.username && url.password && decodeURIComponent(url.username) === target.role && url.pathname === `/${target.database}` && target.database === 'neondb' && !url.hash, 'DATABASE_OR_ROLE_MISMATCH')
  const allowed = new Set(['sslmode', 'schema', 'connect_timeout', 'connection_limit'])
  requireCheck([...url.searchParams.keys()].every(k => allowed.has(k)) && new Set(url.searchParams.keys()).size === [...url.searchParams.keys()].length, 'CONNECTION_OPTIONS_REJECTED')
  requireCheck(['require', 'verify-full'].includes(url.searchParams.get('sslmode')) && (!url.searchParams.has('schema') || url.searchParams.get('schema') === 'public'), 'TLS_OR_SCHEMA_REJECTED')
  const age = now - Date.parse(target.verifiedAt)
  requireCheck(Number.isFinite(age) && age >= 0 && age <= 6 * 60 * 60 * 1000, 'TARGET_VERIFICATION_EXPIRED')
  requireCheck(Number.isInteger(target.expectedLegacyRates) && target.expectedLegacyRates >= 0, 'PREFLIGHT_COUNT_REQUIRED')
  return target
}
export function inventory(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().map(name => ({
    name, checksum: createHash('sha256').update(readFileSync(`${directory}/${name}/migration.sql`)).digest('hex'),
  }))
}
export function checkHistory(rows, migrations, after = false) {
  requireCheck(migrations.length === 17 && JSON.stringify(migrations.slice(-5).map(m => m.name)) === JSON.stringify(pending), 'MIGRATION_CHAIN_CHANGED')
  const known = new Map(migrations.map(m => [m.name, m.checksum]))
  requireCheck(rows.every(r => known.has(r.migration_name)), 'UNKNOWN_HISTORY')
  requireCheck(rows.every(r => r.finished_at || r.rolled_back_at), 'UNRESOLVED_MIGRATION')
  const successful = rows.filter(r => r.finished_at && !r.rolled_back_at)
  const expected = after ? migrations : migrations.slice(0, -5)
  requireCheck(successful.length === expected.length, 'UNEXPECTED_HISTORY_COUNT')
  for (const m of expected) {
    const matches = successful.filter(r => r.migration_name === m.name)
    requireCheck(matches.length === 1 && matches[0].checksum === m.checksum && matches[0].applied_steps_count === 1, 'HISTORY_CHECKSUM_OR_STEPS_MISMATCH')
  }
  requireCheck(after || !rows.some(r => pending.includes(r.migration_name)), 'CLONE_ALREADY_TOUCHED')
}
