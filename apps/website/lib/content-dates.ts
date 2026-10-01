import type { publicRoutes } from './navigation'

/**
 * Authoritative content update dates for the sitemap. A route appears here only when a person
 * records the date its content last changed in a way worth re-crawling (YYYY-MM-DD, UTC).
 * Not derived from build time, file mtimes or Git history: page content lives in shared files
 * and CI/Vercel checkouts can be shallow, so those would be wrong. Routes without an entry are
 * emitted without lastModified, which sitemaps allow.
 */
export const contentLastUpdated: Partial<Record<(typeof publicRoutes)[number], string>> = {}
