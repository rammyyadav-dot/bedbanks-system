import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { apiRequest, apiRequestWithMeta } from './api/client'
import { ApiResponseError } from './api/errors'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const respond = (status: number, body: string, headers: Record<string, string> = { 'x-request-id': 'req-123' }) => {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as typeof fetch
}
async function failure(run: () => Promise<unknown>): Promise<ApiResponseError> {
  try { await run() } catch (error) { assert.ok(error instanceof ApiResponseError, `expected ApiResponseError, got ${String(error)}`); return error }
  assert.fail('the request was treated as a success')
}

test('the success envelope is unwrapped and the request id is returned', async () => {
  respond(200, JSON.stringify({ success: true, data: { saved: true } }))
  assert.deepEqual(await apiRequestWithMeta('/x'), { data: { saved: true }, requestId: 'req-123' })
  respond(200, JSON.stringify({ success: true, data: null }))
  assert.equal(await apiRequest('/x'), null, 'a null payload is a real answer')
})

for (const [label, body] of [
  ['an empty body', ''],
  ['a truncated body', '{"success":true,"data":{"sav'],
  ['an HTML page from a proxy', '<html><body>Bad gateway</body></html>'],
  ['a JSON array', '[1,2]'],
  ['a bare JSON string', '"ok"'],
  ['a JSON null', 'null'],
  ['an object that is not the envelope', '{"saved":true}'],
  ['success:true without data', '{"success":true}'],
  ['success as a string', '{"success":"true","data":{}}'],
] as const) {
  test(`HTTP 200 with ${label} is not a successful mutation`, async () => {
    respond(200, body)
    const error = await failure(() => apiRequestWithMeta('/hotel/1', { method: 'PATCH', body: '{}' }))
    assert.equal(error.code, 'API_MALFORMED_RESPONSE')
    assert.equal(error.status, 200)
    assert.equal(error.requestId, 'req-123', 'the request id survives so the response can be traced')
    assert.equal(error.details.length, 1)
    assert.match(error.message, /may not have been applied/)
  })
}

test('success:false inside an HTTP 200 keeps the API code, message, details and request id', async () => {
  respond(200, JSON.stringify({ success: false, error: { code: 'HOTEL_SETUP_STALE', message: 'This hotel changed.', details: ['name: stale', { check: 'x' }, 7] } }))
  const error = await failure(() => apiRequest('/x'))
  assert.equal(error.code, 'HOTEL_SETUP_STALE')
  assert.equal(error.message, 'This hotel changed.')
  assert.deepEqual(error.details, ['name: stale'])
  assert.deepEqual(error.structuredDetails, [{ check: 'x' }])
  assert.equal(error.requestId, 'req-123')
})

test('success:false without an error object still fails, with generic text', async () => {
  respond(200, JSON.stringify({ success: false }))
  const error = await failure(() => apiRequest('/x'))
  assert.equal(error.code, 'API_REQUEST_FAILED')
  assert.equal(error.message, 'The request failed.')
  respond(200, JSON.stringify({ success: false, error: 'boom' }))
  assert.equal((await failure(() => apiRequest('/x'))).message, 'The request failed.', 'a non-object error is ignored, never trusted')
})

test('HTTP errors keep their code, details and request id, including when the body is not JSON', async () => {
  respond(409, JSON.stringify({ success: false, error: { code: 'HOTEL_SETUP_STALE', message: 'Reload.', details: ['a'] } }))
  const stale = await failure(() => apiRequest('/x'))
  assert.deepEqual([stale.status, stale.code, stale.details, stale.requestId], [409, 'HOTEL_SETUP_STALE', ['a'], 'req-123'])
  respond(502, '<html>bad gateway</html>')
  const gateway = await failure(() => apiRequest('/x'))
  assert.deepEqual([gateway.status, gateway.code, gateway.requestId], [502, 'API_REQUEST_FAILED', 'req-123'])
  respond(500, JSON.stringify({ error: { details: 'not-an-array' } }), {})
  const odd = await failure(() => apiRequest('/x'))
  assert.deepEqual([odd.details, odd.requestId], [[], null])
})

test('a network failure and a body that dies mid-read are NETWORK_ERROR', async () => {
  globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  assert.equal((await failure(() => apiRequest('/x'))).code, 'NETWORK_ERROR')
  globalThis.fetch = (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError('terminated') } }) as unknown as Response) as typeof fetch
  assert.equal((await failure(() => apiRequest('/x'))).code, 'NETWORK_ERROR')
})
