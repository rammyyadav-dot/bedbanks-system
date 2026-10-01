/**
 * Checks a STARTED PRODUCTION BUILD: sitemap routes, canonical URLs, robots, navigation links,
 * in-page and cross-page anchors, portal redirects and (optionally) external links.
 *
 *   pnpm build && pnpm exec next start -p 4710 &
 *   CHECK_BASE_URL=http://localhost:4710 pnpm check:site [--external]
 *
 * Internal failures always fail the run. External links are checked only with --external and are
 * resilient: network errors, timeouts, 429 and 5xx are warnings; 404 and 410 are failures.
 */
import { privacyPolicyApproved } from '../lib/legal-status'
import { classifyLink, extractCanonical, extractIds, extractLinks, hasNoindex, parseSitemapLocs } from './site-checks'

const base = new URL(process.env.CHECK_BASE_URL ?? 'http://localhost:4710')
const expectedSite = (process.env.EXPECTED_SITE_URL ?? 'https://www.fbeds.com').replace(/\/$/, '')
const checkExternal = process.argv.includes('--external')
const failures: string[] = []
const warnings: string[] = []
const fail = (message: string) => failures.push(message)

async function fetchPage(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, base), { redirect: 'manual', ...init })
}

type PageInfo = { status: number; html: string; ids: Set<string> }
const pages = new Map<string, PageInfo>()
async function loadPage(path: string): Promise<PageInfo> {
  const key = path.split('#')[0]
  const cached = pages.get(key)
  if (cached) return cached
  const response = await fetchPage(key)
  const html = response.status === 200 ? await response.text() : ''
  const info = { status: response.status, html, ids: extractIds(html) }
  pages.set(key, info)
  return info
}

async function checkSitemapAndCanonicals(): Promise<string[]> {
  const response = await fetchPage('/sitemap.xml')
  if (response.status !== 200) { fail(`sitemap.xml returned ${response.status}`); return [] }
  const locs = parseSitemapLocs(await response.text())
  if (!locs.length) fail('sitemap.xml lists no URLs')
  const paths: string[] = []
  for (const loc of locs) {
    if (loc !== expectedSite && !loc.startsWith(`${expectedSite}/`)) { fail(`sitemap URL is not on ${expectedSite}: ${loc}`); continue }
    const path = new URL(loc).pathname
    paths.push(path)
    const page = await loadPage(path)
    if (page.status !== 200) { fail(`sitemap route ${path} returned ${page.status}`); continue }
    const canonical = extractCanonical(page.html)
    // https://host and https://host/ are the same URL; compare in normalized form.
    if (!canonical || new URL(canonical).href !== new URL(loc).href) fail(`canonical for ${path} is ${canonical ?? 'missing'}, expected ${loc}`)
    if (hasNoindex(page.html)) fail(`sitemap route ${path} is marked noindex`)
  }
  if (!privacyPolicyApproved && paths.includes('/privacy')) fail('/privacy is in the sitemap before legal approval')
  return paths
}

async function checkRobots(): Promise<void> {
  const response = await fetchPage('/robots.txt')
  const text = response.status === 200 ? await response.text() : ''
  if (!text.includes(`Sitemap: ${expectedSite}/sitemap.xml`)) fail(`robots.txt does not reference ${expectedSite}/sitemap.xml`)
  for (const path of ['/agent', '/supplier', '/admin', '/portals']) if (!new RegExp(`Disallow:\\s*${path}\\b`).test(text)) fail(`robots.txt does not disallow ${path}`)
}

async function checkPortalRedirects(): Promise<void> {
  for (const [path, key] of [['/admin', 'admin'], ['/agent', 'agent'], ['/supplier', 'supplier']] as const) {
    const response = await fetchPage(path)
    const location = response.headers.get('location') ?? ''
    if (![307, 308].includes(response.status)) { fail(`${path} should redirect (got ${response.status})`); continue }
    if (!location.includes(`target=${key}`) && !/^https?:\/\//.test(location)) fail(`${path} redirects to an unexpected place: ${location}`)
    const target = await fetchPage(location.startsWith('http') ? location : location)
    if (!location.startsWith('http') && target.status !== 200) fail(`${path} -> ${location} returned ${target.status}`)
  }
}

async function crawl(seedPaths: string[]): Promise<Set<string>> {
  const external = new Set<string>()
  for (const seed of seedPaths) {
    const page = await loadPage(seed)
    if (page.status !== 200) { fail(`${seed} returned ${page.status}`); continue }
    for (const href of new Set(extractLinks(page.html))) {
      const link = classifyLink(href, base.origin, seed)
      if (link.kind === 'skip') continue
      if (link.kind === 'external') { external.add(link.url); continue }
      const path = link.path.split('#')[0]
      if (['/admin', '/agent', '/supplier'].includes(path)) continue // redirects are verified separately
      const target = await loadPage(path)
      if (target.status !== 200) { fail(`${seed}: link ${href} -> ${target.status}`); continue }
      if (link.hash && !target.ids.has(link.hash)) fail(`${seed}: link ${href} points at a missing anchor #${link.hash}`)
    }
  }
  return external
}

async function checkExternalLinks(urls: Set<string>): Promise<void> {
  for (const url of urls) {
    let outcome = ''
    for (let attempt = 0; attempt < 3 && outcome !== 'ok'; attempt += 1) {
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) })
        if (response.status === 404 || response.status === 410) { fail(`external link is gone (${response.status}): ${url}`); outcome = 'ok'; break }
        outcome = response.ok ? 'ok' : `status ${response.status}`
      } catch { outcome = 'network error' }
      if (outcome !== 'ok') await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
    if (outcome !== 'ok') warnings.push(`external link not verified (${outcome}): ${url}`)
  }
}

async function main(): Promise<void> {
  const sitemapPaths = await checkSitemapAndCanonicals()
  await checkRobots()
  await checkPortalRedirects()
  const external = await crawl([...new Set([...sitemapPaths, '/login', '/portals'])])
  if (checkExternal) await checkExternalLinks(external)
  console.log(`Checked ${pages.size} pages, ${external.size} external link(s)${checkExternal ? '' : ' (not requested)'}.`)
  for (const warning of warnings) console.warn(`WARN ${warning}`)
  if (failures.length) { for (const failure of failures) console.error(`FAIL ${failure}`); process.exit(1) }
  console.log('Built-site checks passed.')
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
