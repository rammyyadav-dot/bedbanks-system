import assert from 'node:assert/strict'
import test from 'node:test'
import { portalApiUrl } from './api-url.mjs'

test('local development preserves the documented API default', () => {
  assert.equal(portalApiUrl({}), 'http://localhost:3002/api/v1')
})

test('hosted portals reject missing, insecure, malformed and mis-prefixed API URLs', () => {
  for (const value of [undefined, '', '  ', 'not a URL', 'http://api.example/api/v1', 'https://localhost/api/v1', 'https://localhost./api/v1', 'https://127.1/api/v1', 'https://[::1]/api/v1', 'https://user:secret@api.example/api/v1', 'https://api.example', 'https://api.example/api/v1/api/v1', 'https://api.example/api/v1?token=secret', 'https://api.example/api/v1#fragment']) {
    assert.throws(() => portalApiUrl({ VERCEL: '1', API_INTERNAL_URL: value }))
  }
})

test('container images are hosted too: PORTAL_HOSTED=1 enforces the same rules as VERCEL=1', () => {
  assert.throws(() => portalApiUrl({ PORTAL_HOSTED: '1' }), /required for hosted portal/)
  assert.throws(() => portalApiUrl({ PORTAL_HOSTED: '1', API_INTERNAL_URL: 'http://api.internal/api/v1' }))
  assert.equal(portalApiUrl({ PORTAL_HOSTED: '1', API_INTERNAL_URL: 'https://api.example.com/api/v1' }), 'https://api.example.com/api/v1')
})

test('each portal uses the validated destination and preserves the API path', async () => {
  const saved = { VERCEL: process.env.VERCEL, API_INTERNAL_URL: process.env.API_INTERNAL_URL }
  process.env.VERCEL = '1'
  process.env.API_INTERNAL_URL = 'https://api.example/api/v1/'
  try {
    for (const app of ['agent', 'admin', 'supplier']) {
      const config = (await import(`../../apps/${app}/next.config.mjs?deployment-test`)).default
      assert.deepEqual(await config.rewrites(), [{ source: '/api/v1/:path*', destination: 'https://api.example/api/v1/:path*' }])
      assert.notEqual(config.typescript?.ignoreBuildErrors, true)
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
