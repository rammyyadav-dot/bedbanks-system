import assert from 'node:assert/strict'
import test from 'node:test'
import robots from '../app/robots'
import sitemap from '../app/sitemap'
import { pageMetadata } from '../lib/seo'
import { privacyPolicyApproved } from '../lib/legal-status'
import { contentLastUpdated } from '../lib/content-dates'
import { publicRoutes } from '../lib/navigation'
test('generates canonical and social metadata for a route', () => { const metadata = pageMetadata({ title: 'Example', description: 'Distinct description', path: '/platform' }); assert.match(String(metadata.alternates?.canonical), /\/platform$/); assert.equal(metadata.openGraph?.title, 'Example'); assert.match(JSON.stringify(metadata.twitter), /summary_large_image/) })
test('sitemap contains every indexable public route and no portal placeholders', () => { const urls = sitemap().map((entry) => new URL(entry.url).pathname); assert.deepEqual(urls.sort(), publicRoutes.filter((route) => route !== '/portals' && (route !== '/privacy' || privacyPolicyApproved)).sort()) })
test('robots allows the site but excludes operational placeholders', () => { const output = robots(); const rule = Array.isArray(output.rules) ? output.rules[0] : output.rules; assert.deepEqual(rule.disallow, ['/agent', '/supplier', '/admin', '/portals']); assert.match(String(output.sitemap), /\/sitemap\.xml$/) })

test('the unapproved privacy notice is not in the sitemap', () => { assert.equal(privacyPolicyApproved, false); assert.ok(!sitemap().some((entry) => new URL(entry.url).pathname === '/privacy')) })

test('sitemap dates come only from recorded content dates, never from build time or a fixed constant', () => {
  const recorded = contentLastUpdated as Record<string, string>
  for (const entry of sitemap()) {
    const path = new URL(entry.url).pathname
    if (recorded[path]) assert.equal(entry.lastModified, recorded[path]); else assert.equal(entry.lastModified, undefined, `${path} must not carry an invented date`)
  }
})
test('recorded content dates are valid, not in the future, and belong to public routes', () => {
  for (const [route, date] of Object.entries(contentLastUpdated)) {
    assert.ok((publicRoutes as readonly string[]).includes(route), route)
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(!Number.isNaN(Date.parse(`${date}T00:00:00Z`)), date); assert.ok(Date.parse(`${date}T00:00:00Z`) <= Date.now(), `${route} is dated in the future`)
  }
})
test('the sitemap and canonical URLs use the production origin when configured', () => { assert.ok(sitemap().every((entry) => entry.url.startsWith(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.fbeds.com') || !process.env.NEXT_PUBLIC_SITE_URL)) })
