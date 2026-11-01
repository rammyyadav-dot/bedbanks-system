import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'

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

/** Attributes that hold a full URL or request target, across old and new HTTP semantic conventions and Next.js' own spans. */
const URL_ATTRIBUTES = ['http.url', 'http.target', 'url.full', 'url.path'] as const

/** Rewrites URL attributes in place (path only) and blanks `url.query`. Never throws. */
export function scrubSpanUrlAttributes(attributes: Record<string, unknown>): void {
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key]
    if (typeof value === 'string') attributes[key] = scrubbedUrl(value)
  }
  if ('url.query' in attributes) attributes['url.query'] = ''
}

/**
 * Runs before the exporting processor, on every span from every instrumentation (http, Next.js, anything added later), so no single
 * instrumentation hook has to remember to scrub. The attributes object of an ended span is still the live one the exporter reads.
 */
export class UrlScrubbingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _context: Context): void {}
  onEnd(span: ReadableSpan): void { scrubSpanUrlAttributes(span.attributes as Record<string, unknown>) }
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
}
