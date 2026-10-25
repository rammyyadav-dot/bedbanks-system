/**
 * Span URLs reach the trace store, which is not a place for query strings: they can carry search terms, reset tokens or supplier
 * credentials (invariant 7). Only scheme, host and path are kept.
 */
export function scrubbedUrl(raw: string): string {
  try {
    const url = new URL(raw, 'http://placeholder.invalid')
    const origin = raw.startsWith('/') ? '' : url.origin
    return `${origin}${url.pathname}`
  } catch {
    return '[unparseable-url]'
  }
}

export function scrubSpanUrlAttributes(span: { setAttribute(key: string, value: string): unknown }, raw: string | undefined): void {
  if (!raw) return
  const clean = scrubbedUrl(raw)
  span.setAttribute('http.target', clean)
  span.setAttribute('url.full', clean)
  span.setAttribute('url.query', '')
}
