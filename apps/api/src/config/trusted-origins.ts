import type { ConfigService } from '@nestjs/config'
import type { AppConfig } from './configuration'

/** Splits a comma-separated origin list, dropping blanks and duplicates. */
export function parseOriginList(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean))]
}

/** Exact origins allowed to make cookie-authenticated mutations: Admin plus listed portals. */
export function trustedOrigins(config: ConfigService<AppConfig>): string[] {
  const admin = config.get('adminOrigin', { infer: true })
  const extra = config.get('trustedOrigins', { infer: true })
  return [...(admin ? [admin] : []), ...(Array.isArray(extra) ? extra : [])]
}

export function isTrustedOrigin(config: ConfigService<AppConfig>, origin: string | undefined): boolean {
  return origin !== undefined && trustedOrigins(config).includes(origin)
}
