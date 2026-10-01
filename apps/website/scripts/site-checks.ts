/** Pure helpers for check-built-site.ts (kept side-effect free so they are unit-tested). */

export function extractLinks(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*?\shref=(?:"([^"]*)"|'([^']*)')/gi)].map((match) => decodeEntities(match[1] ?? match[2] ?? ''))
}

export function extractIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid=(?:"([^"]+)"|'([^']+)')/gi)].map((match) => match[1] ?? match[2]))
}

export function extractCanonical(html: string): string | undefined {
  const tag = /<link\b[^>]*\brel=["']canonical["'][^>]*>/i.exec(html)?.[0]
  return tag ? /\bhref=["']([^"']+)["']/i.exec(tag)?.[1] : undefined
}

export function hasNoindex(html: string): boolean {
  return /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["'][^"']*noindex/i.test(html)
}

export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => decodeEntities(match[1]))
}

export type LinkKind = { kind: 'skip' } | { kind: 'internal'; path: string; hash?: string } | { kind: 'external'; url: string }

/** Classifies an href found on a page served from `origin`. */
export function classifyLink(href: string, origin: string, page: string): LinkKind {
  const value = href.trim()
  if (!value || /^(mailto:|tel:|javascript:|data:)/i.test(value)) return { kind: 'skip' }
  let url: URL
  try { url = new URL(value, new URL(page, origin)) } catch { return { kind: 'skip' } }
  if (url.origin !== origin) return /^https?:$/.test(url.protocol) ? { kind: 'external', url: url.toString() } : { kind: 'skip' }
  return { kind: 'internal', path: url.pathname + url.search, hash: url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined }
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
