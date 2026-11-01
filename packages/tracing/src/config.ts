export type Env = Record<string, string | undefined>

export function tracingEnabled(env: Env = process.env): boolean {
  return env.OTEL_TRACING_ENABLED === 'true'
}

/** Fraction of root requests sampled (0..1). A malformed value falls back to 10%, never to "trace everything". */
export function sampleRatio(env: Env = process.env): number {
  const raw = env.OTEL_TRACE_SAMPLE_RATIO
  if (raw === undefined || raw === '') return 0.1
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.1
}
