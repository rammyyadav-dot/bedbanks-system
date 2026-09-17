import assert from 'node:assert/strict'
import test from 'node:test'
import robots from '../app/robots'
import sitemap from '../app/sitemap'
import { pageMetadata } from '../lib/seo'
import { publicRoutes } from '../lib/navigation'
test('generates canonical and social metadata for a route', () => { const metadata = pageMetadata({ title: 'Example', description: 'Distinct description', path: '/platform' }); assert.match(String(metadata.alternates?.canonical), /\/platform$/); assert.equal(metadata.openGraph?.title, 'Example'); assert.match(JSON.stringify(metadata.twitter), /summary_large_image/) })
test('sitemap contains every indexable public route and no portal placeholders', () => { const entries = sitemap(); const urls = entries.map((entry) => new URL(entry.url).pathname); assert.deepEqual(urls.sort(), publicRoutes.filter((route) => route !== '/portals').sort()); assert.ok(entries.every((entry) => entry.lastModified?.toString() === 'Wed Sep 17 2026 00:00:00 GMT+0000 (Coordinated Universal Time)' || new Date(entry.lastModified!).toISOString() === '2026-09-17T00:00:00.000Z')) })
test('robots allows the site but excludes operational placeholders', () => { const output = robots(); const rule = Array.isArray(output.rules) ? output.rules[0] : output.rules; assert.deepEqual(rule.disallow, ['/agent', '/supplier', '/admin', '/portals']); assert.match(String(output.sitemap), /\/sitemap\.xml$/) })
