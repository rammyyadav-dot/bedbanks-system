// Runtime resolution of the same-origin /api/v1 proxy destination for the Agent, Admin and Supplier portals (ADR 0055 decision 5).
// Evaluated per request from the process environment, so ONE immutable image serves any environment. Nothing here is a build-time value.
import { portalApiUrl } from './api-url.mjs'

export const API_PREFIX = '/api/v1'

/**
 * @param {string} pathname request path, as seen by the portal (must start with /api/v1)
 * @param {string} search   request query string including the leading "?" (or "")
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, url: string } | { ok: false, status: 404 | 503, reason: string }}
 *   `reason` is a fixed code, never the configured URL or any request data.
 */
export function resolveApiDestination(pathname, search = '', env = process.env) {
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return { ok: false, status: 404, reason: 'not_api_path' }
  let base
  try {
    base = portalApiUrl(env)
  } catch {
    return { ok: false, status: 503, reason: 'portal_api_origin_misconfigured' }
  }
  const baseUrl = new URL(base)
  let destination
  try {
    destination = new URL(`${base}${pathname.slice(API_PREFIX.length)}${search}`)
  } catch {
    return { ok: false, status: 404, reason: 'bad_path' }
  }
  // Containment: dot segments (also percent-encoded, and backslashes) must not climb out of /api/v1 on the API origin,
  // otherwise a portal visitor could reach non-API routes such as the internal Swagger UI.
  if (destination.origin !== baseUrl.origin || (destination.pathname !== API_PREFIX && !destination.pathname.startsWith(`${API_PREFIX}/`))) {
    return { ok: false, status: 404, reason: 'path_escapes_api_prefix' }
  }
  return { ok: true, url: destination.toString() }
}
