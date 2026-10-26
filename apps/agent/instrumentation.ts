// Next.js calls register() once per server start (ADR 0093). Tracing is Node-only and off unless OTEL_TRACING_ENABLED=true.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation.node')
}
