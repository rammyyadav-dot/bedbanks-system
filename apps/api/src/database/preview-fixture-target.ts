import { checkTarget } from './provision-hold-expiry-role.cli'

/** Empty disposable database name. Never point this at a persistent environment. */
export const PREVIEW_FIXTURE_DATABASE = 'fbeds_preview_xt'

const BLOCKED_DATABASES = new Set([
  'fbeds',
  'fbeds_dev',
  'fbeds_golden',
  'fbeds_ci',
  'fbeds_supplier_xt',
  'postgres',
  'neondb',
  'production',
  'prod',
])

/**
 * Preview fixtures may run only against the named disposable database.
 * A remote host also needs the existing owner approval flags, and the
 * confirmed name must still be the disposable database.
 */
export function assertPreviewFixtureTarget(rawUrl: string, args: string[]): { host: string; database: string } {
  const target = checkTarget(rawUrl, args)
  if (target.database !== PREVIEW_FIXTURE_DATABASE || BLOCKED_DATABASES.has(target.database)) {
    throw new Error(`Preview fixtures refuse database "${target.database}". Create an empty ${PREVIEW_FIXTURE_DATABASE} database first.`)
  }
  return target
}
