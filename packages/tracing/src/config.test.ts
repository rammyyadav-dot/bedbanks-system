import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sampleRatio, tracingEnabled } from './config'

test('tracing is off unless explicitly enabled', () => {
  assert.equal(tracingEnabled({}), false)
  assert.equal(tracingEnabled({ OTEL_TRACING_ENABLED: '1' }), false)
  assert.equal(tracingEnabled({ OTEL_TRACING_ENABLED: 'true' }), true)
})
test('sampling defaults to 10% and never widens to full sampling on a bad value', () => {
  assert.equal(sampleRatio({}), 0.1)
  assert.equal(sampleRatio({ OTEL_TRACE_SAMPLE_RATIO: '0.5' }), 0.5)
  assert.equal(sampleRatio({ OTEL_TRACE_SAMPLE_RATIO: '0' }), 0)
  for (const bad of ['abc', '2', '-1', 'NaN']) assert.equal(sampleRatio({ OTEL_TRACE_SAMPLE_RATIO: bad }), 0.1)
})
