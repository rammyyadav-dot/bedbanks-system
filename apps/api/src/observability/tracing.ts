import { SpanStatusCode, context, trace, type Attributes, type Span } from '@opentelemetry/api'

const tracer = trace.getTracer('fbeds-api')

/**
 * Runs `fn` inside a child span of the active one. With no tracing SDK registered (local development, tests, tracing off) the
 * API returns non-recording spans, so this costs one function call. Only the supplied attributes and an error `code` are recorded:
 * never an error message, which can embed a supplier payload (invariant 7).
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async span => {
    try {
      return await fn(span)
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.setAttribute('error.code', errorCode(error))
      throw error
    } finally {
      span.end()
    }
  })
}

export function currentTraceId(): string | undefined {
  const id = trace.getActiveSpan()?.spanContext().traceId
  return id && /^0+$/.test(id) ? undefined : id
}

/** Ties a trace to the `X-Request-ID` that logs, audit payloads and supplier correlation ids already carry. */
export function tagActiveSpanWithRequestId(requestId: string): void {
  trace.getActiveSpan()?.setAttribute('app.request_id', requestId)
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name.slice(0, 64) : 'unknown'
}

export { context }
