import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSuccessEnvelope, parseApiEnvelope } from './envelope.ts'

test('success is only { success: true, data }, and data may be null', () => {
  assert.equal(isSuccessEnvelope({ success: true, data: { ok: 1 } }), true)
  assert.equal(isSuccessEnvelope({ success: true, data: null }), true)
  assert.equal(isSuccessEnvelope({ success: true }), false)
  assert.equal(isSuccessEnvelope({ success: 'true', data: {} }), false)
  assert.equal(isSuccessEnvelope({ data: {} }), false)
  assert.equal(isSuccessEnvelope({ saved: true }), false)
  assert.equal(isSuccessEnvelope([1]), false)
  assert.equal(isSuccessEnvelope(null), false)
})

test('HTTP 2xx that is not the envelope is malformed and never data', () => {
  for (const [text, reason] of [
    ['', 'The response body was empty.'],
    ['{"success":true,"data":{"sav', 'The response was not valid JSON.'],
    ['<html><body>Bad gateway</body></html>', 'The response was not valid JSON.'],
    ['[1,2]', 'The response was not a JSON object.'],
    ['"ok"', 'The response was not a JSON object.'],
    ['null', 'The response was not a JSON object.'],
    ['{"saved":true}', 'The response was not the API success envelope.'],
    ['{"success":true}', 'The response was not the API success envelope.'],
    ['{"success":"true","data":{}}', 'The response was not the API success envelope.'],
  ] as const) {
    const parsed = parseApiEnvelope(200, text)
    assert.equal(parsed.kind, 'malformed', text)
    if (parsed.kind === 'malformed') assert.equal(parsed.reason, reason)
  }
})

test('success false keeps the API code, message and only string or object details', () => {
  const parsed = parseApiEnvelope(200, JSON.stringify({ success: false, error: { code: 'HOTEL_SETUP_STALE', message: 'This hotel changed.', details: ['name: stale', { check: 'x' }, 7] } }))
  assert.deepEqual(parsed, { kind: 'failure', code: 'HOTEL_SETUP_STALE', message: 'This hotel changed.', details: ['name: stale'], structuredDetails: [{ check: 'x' }] })
  const bare = parseApiEnvelope(200, JSON.stringify({ success: false }))
  assert.equal(bare.kind, 'failure')
  if (bare.kind === 'failure') assert.deepEqual([bare.code, bare.message, bare.details], [null, null, []])
  const odd = parseApiEnvelope(200, JSON.stringify({ success: false, error: 'boom' }))
  if (odd.kind === 'failure') assert.equal(odd.message, null)
})

test('a non-2xx body is a failure even when it is HTML or a partial error object', () => {
  const html = parseApiEnvelope(502, '<html>bad gateway</html>')
  assert.equal(html.kind, 'failure')
  if (html.kind === 'failure') assert.deepEqual([html.code, html.message, html.details], [null, null, []])
  const stale = parseApiEnvelope(409, JSON.stringify({ success: false, error: { code: 'HOTEL_SETUP_STALE', message: 'Reload.', details: ['a'] } }))
  if (stale.kind === 'failure') assert.deepEqual([stale.code, stale.message, stale.details], ['HOTEL_SETUP_STALE', 'Reload.', ['a']])
  const odd = parseApiEnvelope(500, JSON.stringify({ error: { details: 'not-an-array' } }))
  if (odd.kind === 'failure') assert.deepEqual(odd.details, [])
})

test('a real success envelope returns data, including null', () => {
  assert.deepEqual(parseApiEnvelope(200, JSON.stringify({ success: true, data: { saved: true } })), { kind: 'success', data: { saved: true } })
  assert.deepEqual(parseApiEnvelope(201, JSON.stringify({ success: true, data: null })), { kind: 'success', data: null })
})
