import { sampleRatio, tracingEnabled } from './tracing-bootstrap'

describe('tracing configuration', () => {
  it('is off unless explicitly enabled', () => {
    expect(tracingEnabled({})).toBe(false)
    expect(tracingEnabled({ OTEL_TRACING_ENABLED: '1' })).toBe(false)
    expect(tracingEnabled({ OTEL_TRACING_ENABLED: 'true' })).toBe(true)
  })
  it('defaults to 10% and never widens to full sampling on a bad value', () => {
    expect(sampleRatio({})).toBe(0.1)
    expect(sampleRatio({ OTEL_TRACE_SAMPLE_RATIO: '0.5' })).toBe(0.5)
    expect(sampleRatio({ OTEL_TRACE_SAMPLE_RATIO: '0' })).toBe(0)
    for (const bad of ['abc', '2', '-1', 'NaN']) expect(sampleRatio({ OTEL_TRACE_SAMPLE_RATIO: bad })).toBe(0.1)
  })
})
