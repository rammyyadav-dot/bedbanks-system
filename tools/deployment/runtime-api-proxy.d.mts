export const API_PREFIX: '/api/v1'
export type ApiDestination = { ok: true; url: string } | { ok: false; status: 404 | 503; reason: string }
export function resolveApiDestination(pathname: string, search?: string, env?: Record<string, string | undefined>): ApiDestination
