import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyLink, extractCanonical, extractIds, extractLinks, hasNoindex, parseSitemapLocs } from '../scripts/site-checks'

const origin = 'http://localhost:4710'
test('extracts links and ids, decoding entities', () => {
  const html = '<a class="x" href="/a?x=1&amp;y=2">A</a><a href=\'#top\'>T</a><div id="top"></div><section id=\'s\'></section>'
  assert.deepEqual(extractLinks(html), ['/a?x=1&y=2', '#top'])
  assert.deepEqual([...extractIds(html)].sort(), ['s', 'top'])
})
test('classifies internal, hash, external and skipped links', () => {
  assert.deepEqual(classifyLink('/about', origin, '/'), { kind: 'internal', path: '/about', hash: undefined })
  assert.deepEqual(classifyLink('#ecosystem', origin, '/'), { kind: 'internal', path: '/', hash: 'ecosystem' })
  assert.deepEqual(classifyLink('/solutions#hotels', origin, '/'), { kind: 'internal', path: '/solutions', hash: 'hotels' })
  assert.deepEqual(classifyLink('https://example.com/x', origin, '/'), { kind: 'external', url: 'https://example.com/x' })
  assert.deepEqual(classifyLink('mailto:hello@fbeds.com', origin, '/'), { kind: 'skip' })
  assert.deepEqual(classifyLink('', origin, '/'), { kind: 'skip' })
})
test('reads canonical, noindex and sitemap locations', () => {
  assert.equal(extractCanonical('<link rel="canonical" href="https://www.fbeds.com/a"/>'), 'https://www.fbeds.com/a')
  assert.equal(extractCanonical('<html></html>'), undefined)
  assert.equal(hasNoindex('<meta name="robots" content="noindex, follow"/>'), true)
  assert.equal(hasNoindex('<meta name="robots" content="index, follow"/>'), false)
  assert.deepEqual(parseSitemapLocs('<urlset><url><loc>https://www.fbeds.com/</loc></url><url><loc> https://www.fbeds.com/a?x=1&amp;y=2 </loc></url></urlset>'), ['https://www.fbeds.com/', 'https://www.fbeds.com/a?x=1&y=2'])
})
