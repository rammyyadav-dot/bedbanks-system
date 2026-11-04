import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiClientError, createHttpClient, unwrapEnvelope } from './http.ts'

test('unwrapEnvelope reads only the NestJS success envelope', () => {
  assert.deepEqual(unwrapEnvelope({ success: true, data: { ok: 1 } }), { ok: 1 })
  assert.equal(unwrapEnvelope({ success: true, data: null }), null)
  assert.throws(() => unwrapEnvelope({ raw: true }), (error: unknown) => error instanceof ApiClientError && error.code === 'API_MALFORMED_RESPONSE')
  assert.throws(() => unwrapEnvelope({ data: { ok: 1 } }), (error: unknown) => error instanceof ApiClientError && error.status === 502)
  assert.throws(() => unwrapEnvelope({ success: true }), (error: unknown) => error instanceof ApiClientError)
  assert.throws(() => unwrapEnvelope({ success: false, error: { code: 'HOTEL_SETUP_STALE', message: 'Reload.' } }), (error: unknown) => error instanceof ApiClientError && error.code === 'HOTEL_SETUP_STALE' && error.status === 200)
})

test('createHttpClient unwraps /auth/login and maps 401', async () => {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ success: true, data: { user: { id: 'u1' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const client = createHttpClient({ baseUrl: 'http://api.test/api/v1' })
    const data = await client.request<{ user: { id: string } }>('/auth/login', { method: 'POST', body: '{}' })
    assert.equal(data.user.id, 'u1')
    assert.equal(calls[0], 'http://api.test/api/v1/auth/login')
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHENTICATED', message: 'no' } }), { status: 401 })) as typeof fetch
  const unauthorized: string[] = []
  try {
    const client = createHttpClient({ baseUrl: '/api/v1', onUnauthorized: (path) => unauthorized.push(path) })
    await assert.rejects(() => client.request('/agent/search'), (error: unknown) => error instanceof ApiClientError && error.status === 401)
    assert.deepEqual(unauthorized, ['/agent/search'])
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({ saved: true }), { status: 200 })) as typeof fetch
  try {
    const client = createHttpClient({ baseUrl: '/api/v1' })
    await assert.rejects(() => client.request('/agent/search'), (error: unknown) => error instanceof ApiClientError && error.code === 'API_MALFORMED_RESPONSE')
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (async () => new Response('<html>bad gateway</html>', { status: 200 })) as typeof fetch
  try {
    const client = createHttpClient({ baseUrl: '/api/v1' })
    await assert.rejects(() => client.request('/agent/search'), (error: unknown) => error instanceof ApiClientError && error.code === 'API_MALFORMED_RESPONSE')
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, error: { code: 'HOTEL_SETUP_STALE', message: 'Reload.' } }), { status: 200 })) as typeof fetch
  try {
    const client = createHttpClient({ baseUrl: '/api/v1' })
    await assert.rejects(() => client.request('/x', { method: 'POST' }), (error: unknown) => error instanceof ApiClientError && error.code === 'HOTEL_SETUP_STALE' && error.message === 'Reload.')
  } finally {
    globalThis.fetch = original
  }
})
