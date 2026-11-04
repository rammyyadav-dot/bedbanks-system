import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contractLifecycleRoutes, departments, routes, supplyRoutes } from '@bedbanks/contracts'
import { flatNav } from '../components/layout/nav-config'
import { financeReleaseScope, redirectAdminRoutes, unavailableAdminRoutes } from './route-registry'

const root = join(import.meta.dirname, '..')
const dashboard = join(root, 'app', '(dashboard)')
const catalogs: Record<string, unknown> = { routes, supplyRoutes, contractLifecycleRoutes }

const liveHrefs = departments.flatMap((department) => department.modules.flatMap((module) => module.readiness === 'live' && module.href ? [module.href] : []))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : name === 'page.tsx' ? [path] : []
  })
}

function hrefOf(file: string): string {
  const rel = file.slice(dashboard.length + 1).replace(/\/page\.tsx$/, '')
  return `/${rel}`
}

function resolveModule(spec: string): string | null {
  if (!spec.startsWith('@/')) return null
  const base = join(root, spec.slice(2))
  for (const candidate of [base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function pathsIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/['"`](\/(?:admin|supply|platform|auth)[^'"`$]*)['"`]/g)) found.add(match[1])
  const bindings: Record<string, unknown> = { ...catalogs }
  for (const match of text.matchAll(/const\s+(\w+)\s*=\s*(routes|supplyRoutes|contractLifecycleRoutes)(?:\.(\w+))?/g)) {
    let value = catalogs[match[2]]
    if (match[3] && value && typeof value === 'object') value = (value as Record<string, unknown>)[match[3]]
    if (value && typeof value === 'object') bindings[match[1]] = value
  }
  for (const [name, value] of Object.entries(bindings)) {
    if (!value || typeof value !== 'object') continue
    for (const match of text.matchAll(new RegExp(String.raw`\b${name}\.(\w+)(?:\.(\w+))?`, 'g'))) {
      let child = (value as Record<string, unknown>)[match[1]]
      if (match[2] && child && typeof child === 'object') child = (child as Record<string, unknown>)[match[2]]
      if (typeof child === 'string') found.add(child.split('?')[0])
    }
  }
  return [...found]
}

function exportSlice(source: string, name: string): string | null {
  const start = source.search(new RegExp(`export\\s+(?:async\\s+function|function|const|class|default\\s+function)\\s+${name}\\b`))
  if (start < 0) return null
  const rest = source.slice(start + 1)
  const next = rest.search(/\nexport\s/)
  const body = next < 0 ? source.slice(start) : source.slice(start, start + 1 + next)
  const preamble = source.slice(0, start).split('\n').filter((line) => /^\s*(import |const )/.test(line)).join('\n')
  return `${preamble}\n${body}`
}

function localImports(source: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = []
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"](@\/[^'"]+)['"]/g)) {
    const clause = match[1].replace(/\s+/g, ' ')
    const names: string[] = []
    const brace = clause.match(/\{([^}]+)\}/)
    if (brace) {
      for (const part of brace[1].split(',')) {
        const cleaned = part.trim().replace(/^type\s+/, '')
        if (!cleaned) continue
        const alias = cleaned.split(/\s+as\s+/).pop()!.trim()
        if (alias && alias !== 'type') names.push(alias)
      }
    }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim().replace(/^type\s+/, '')
    if (def && def !== 'type') names.push(def)
    out.push({ spec: match[2], names })
  }
  for (const match of source.matchAll(/import\(\s*['"](@\/[^'"]+)['"]\s*\)/g)) out.push({ spec: match[1], names: [] })
  return out
}

const endpointCache = new Map<string, string[]>()

function endpointsFor(href: string): string[] {
  const cached = endpointCache.get(href)
  if (cached) return cached
  const file = join(dashboard, ...href.split('/').filter(Boolean), 'page.tsx')
  const source = readFileSync(file, 'utf8')
  const found = new Set(pathsIn(source))
  const seen = new Set<string>([file])
  const queue: { source: string; depth: number }[] = [{ source, depth: 0 }]
  while (queue.length) {
    const item = queue.shift()!
    if (item.depth > 2) continue
    for (const imported of localImports(item.source)) {
      const resolved = resolveModule(imported.spec)
      if (!resolved || seen.has(resolved)) continue
      seen.add(resolved)
      const src = readFileSync(resolved, 'utf8')
      let names = imported.names
      if (names.length === 0) {
        names = [...src.matchAll(/export\s+(?:async\s+function|function|const|class|default\s+function)\s+(\w+)/g)].map((match) => match[1]).filter((name) => item.source.includes(name))
      }
      for (const name of names) {
        const slice = exportSlice(src, name)
        if (slice) for (const path of pathsIn(slice)) found.add(path)
      }
      if (resolved.includes(`${join('components')}`) || resolved.includes(`${join('lib')}`)) queue.push({ source: src, depth: item.depth + 1 })
    }
  }
  const paths = [...found]
  endpointCache.set(href, paths)
  return paths
}

function covered(href: string, bases: readonly string[]): boolean {
  return bases.some((base) => href === base || href.startsWith(`${base}/`))
}

test('every live catalogue module has a page and calls an API route', () => {
  assert.ok(liveHrefs.length >= 37, `expected the live catalogue, found ${liveHrefs.length}`)
  const missing: string[] = []
  for (const href of liveHrefs) {
    const file = join(dashboard, ...href.split('/').filter(Boolean), 'page.tsx')
    assert.equal(existsSync(file), true, `${href} needs a page`)
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /FeatureUnavailable/, `${href} must not be a placeholder`)
    const own = endpointsFor(href)
    if (own.length > 0) continue
    const links = [...source.matchAll(/['"`](\/[A-Za-z0-9_./[\]-]+)['"`]/g)].map((match) => match[1])
    const viaLink = links.filter((link) => link !== href && existsSync(join(dashboard, ...link.split('/').filter(Boolean), 'page.tsx'))).flatMap((link) => endpointsFor(link))
    if (viaLink.length === 0) missing.push(href)
  }
  assert.deepEqual(missing, [], `live routes with no API call: ${missing.join(', ')}`)
})

test('every dashboard page is a live module, a child of one, a redirect, or a registered unavailable route', () => {
  const bases = [...new Set([...liveHrefs, ...flatNav.map((item) => item.href)])]
  const unavailable = new Set<string>(unavailableAdminRoutes)
  const redirects = new Set<string>(redirectAdminRoutes)
  for (const file of walk(dashboard)) {
    const href = hrefOf(file)
    const source = readFileSync(file, 'utf8')
    if (unavailable.has(href)) {
      assert.match(source, /FeatureUnavailable/, href)
      assert.doesNotMatch(source, /from ['"]@\/lib\/data|fetch\(/, href)
      continue
    }
    if (redirects.has(href)) {
      assert.match(source, /redirect\(/, href)
      continue
    }
    assert.equal(covered(href, bases), true, `${href} is not in the catalogue, a child route, or the route registry`)
  }
})

test('finance release scope names each live finance screen once', () => {
  const live = liveHrefs.filter((href) => href.startsWith('/finance/'))
  const scoped = [...financeReleaseScope.readOnly, ...financeReleaseScope.uncertifiedMutation]
  assert.deepEqual([...scoped].sort(), [...live].sort())
  assert.equal(new Set(scoped).size, scoped.length)
})

test('generated Next types come from next typegen, not a dev-server cache', () => {
  const env = readFileSync(join(root, 'next-env.d.ts'), 'utf8')
  assert.match(env, /\/\.next\/types\/routes\.d\.ts/)
  assert.doesNotMatch(env, /\.next\/dev\/types/)
  const tsconfig = readFileSync(join(root, 'tsconfig.json'), 'utf8')
  assert.doesNotMatch(tsconfig, /\.next\/dev\/types/)
  const pkg = readFileSync(join(root, 'package.json'), 'utf8')
  assert.match(pkg, /next typegen && node scripts\/ensure-certified-types\.mjs && tsc --noEmit/)
})
