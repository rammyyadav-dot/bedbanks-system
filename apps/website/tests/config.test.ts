import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeUrl, resolveWebsiteConfig } from '../lib/config-utils'
test('normalizes protocols and trailing slashes', () => { assert.equal(normalizeUrl('example.com///'), 'https://example.com'); assert.equal(normalizeUrl('http://localhost:3000/'), 'http://localhost:3000') })
test('rejects unsupported URL protocols', () => assert.throws(() => normalizeUrl('ftp://example.com')))
test('uses safe local portal defaults in development', () => { const config = resolveWebsiteConfig({ NODE_ENV: 'development' }); assert.equal(config.portals.agent, 'http://localhost:3003'); assert.equal(config.portals.supplier, 'http://localhost:3004'); assert.equal(config.portals.admin, 'http://localhost:3001') })
test('never falls back to localhost portals in production', () => { const config = resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://fbeds.example' }); assert.equal(config.portals.agent, undefined); assert.equal(config.portals.supplier, undefined); assert.equal(config.portals.admin, undefined) })
test('normalizes configured external portal URLs', () => { const config = resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_AGENT_URL: 'agent.example.com/' }); assert.equal(config.portals.agent, 'https://agent.example.com') })


test('rejects configured local or unsafe production destinations', () => {
  for (const value of ['http://localhost:3000', 'https://127.0.0.1', 'https://[::1]', 'https://localhost.', 'http://agent.example', 'https://user:password@agent.example', 'not a url']) {
    assert.throws(() => resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_AGENT_URL: value }))
    assert.throws(() => resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: value }))
  }
})
test('configuration changes resolve to new destinations', () => {
  const first = resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_AGENT_URL: 'https://first.example' })
  const second = resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_AGENT_URL: 'https://second.example' })
  assert.notEqual(first.portals.agent, second.portals.agent)
})
