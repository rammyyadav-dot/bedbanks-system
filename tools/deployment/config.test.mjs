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

test('portals resolve the API origin per request: no build-time rewrites, and each proxy.ts uses the shared resolver and an explicit /api/v1 matcher', async () => {
  const { readFileSync } = await import('node:fs')
  for (const app of ['agent', 'admin', 'supplier']) {
    const config = (await import(`../../apps/${app}/next.config.mjs?deployment-test`)).default
    assert.equal(config.rewrites, undefined, `${app}: a next.config rewrite would freeze the API origin at build time`)
    assert.notEqual(config.typescript?.ignoreBuildErrors, true)
    const proxy = readFileSync(new URL(`../../apps/${app}/proxy.ts`, import.meta.url), 'utf8')
    assert.match(proxy, /resolveApiDestination/, `${app}: proxy.ts must use the shared resolver`)
    assert.match(proxy, /'\/api\/v1\/:path\*'/, `${app}: proxy.ts must match /api/v1 explicitly (dotted paths)`)
    assert.doesNotMatch(proxy, /process\.env\.NEXT_PUBLIC/, `${app}: proxy.ts must not read build-time public variables`)
  }
})

test('Vercel builds only main: every portal skips preview builds for other branches (ignoreCommand exit 0 = skip, exit 1 = build)', async () => {
  const { readFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  for (const app of ['agent', 'admin', 'supplier', 'website']) {
    const cfg = JSON.parse(readFileSync(new URL(`../../apps/${app}/vercel.json`, import.meta.url), 'utf8'))
    assert.ok(cfg.ignoreCommand, `${app}: ignoreCommand missing`)
    const exit = (ref) => spawnSync('sh', ['-c', cfg.ignoreCommand], { env: { PATH: process.env.PATH, ...(ref === undefined ? {} : { VERCEL_GIT_COMMIT_REF: ref }) } }).status
    assert.equal(exit('main'), 1, `${app}: main must build (the production fallback)`)
    for (const ref of ['infra/aws-wp3-staging-hardening', 'claude/x', 'feature/main', 'main2', 'Main', '']) assert.equal(exit(ref), 0, `${app}: branch "${ref}" must be skipped`)
  }
})
