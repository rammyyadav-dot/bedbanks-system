import assert from 'node:assert/strict'
import test from 'node:test'
import { portalForHost, portalRedirectUrl, requestHost } from '../lib/portal-routing'
test('extracts the first forwarded host without its port', () => assert.equal(requestHost('Portal.Example.com:443, proxy.local'), 'portal.example.com'))
test('maps known deployed subdomains', () => { assert.equal(portalForHost('portal.fbeds.example', 'fbeds.example'), 'agent'); assert.equal(portalForHost('supplier.fbeds.example', 'fbeds.example'), 'supplier'); assert.equal(portalForHost('ops.fbeds.example', 'fbeds.example'), 'admin') })
test('maps local development subdomains', () => assert.equal(portalForHost('agent.localhost:3000', 'localhost'), 'agent'))
test('leaves unknown and lookalike hosts untouched', () => { assert.equal(portalForHost('www.fbeds.example', 'fbeds.example'), undefined); assert.equal(portalForHost('portal.fbeds.example.evil.test', 'fbeds.example'), undefined) })
test('preserves path and query when constructing a portal redirect', () => assert.equal(portalRedirectUrl('https://agents.example/app/', '/bookings/42', '?currency=EUR'), 'https://agents.example/app/bookings/42?currency=EUR'))
test('does not construct a redirect without a configured target', () => assert.equal(portalRedirectUrl(undefined, '/', ''), undefined))
