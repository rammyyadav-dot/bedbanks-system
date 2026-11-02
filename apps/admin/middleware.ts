/**
 * Next.js 16 renamed the `middleware.ts` convention to `proxy.ts`.
 * This file keeps the requested Admin auth entry and re-exports the live proxy
 * (API rewrite + opaque-session cookie gate, ADR 0010 / ADR 0108).
 */
export { proxy as middleware, config } from './proxy'
