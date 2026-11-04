import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveDepartmentModules } from '@bedbanks/contracts'
import { classifyOpsFailure, OPS_FAILURE_COPY } from './ops-state'
import { ApiResponseError } from './api/errors'
import { mutationBlockedReason, publishBrowserAuthGate } from './auth/mutation-gate'
import { resolveRouteAccess } from './auth/route-access'
import { decideAdminEdgeAccess } from './auth/edge-guard'

const root = join(import.meta.dirname, '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

function moduleSource(href: string): string {
  const page = join(root, 'app', '(dashboard)', ...href.split('/').filter(Boolean), 'page.tsx')
  let source = readFileSync(page, 'utf8')
  const specs = [...source.matchAll(/from '(@\/[^']+)'/g), ...source.matchAll(/import\('(@\/[^']+)'\)/g)]
  for (const spec of specs) {
    const rel = spec[1]!.replace('@/', '')
    for (const suffix of ['.tsx', '.ts', '/index.tsx']) {
      const path = join(root, `${rel}${suffix}`)
      if (existsSync(path)) source += `\n${readFileSync(path, 'utf8')}`
    }
  }
  return source
}

const live = liveDepartmentModules()

test('route smoke: every live module has a real page, a heading, and is not a placeholder', () => {
  assert.ok(live.length >= 37, `the catalogue has ${live.length} live modules`)
  assert.equal(new Set(live.map((module) => module.href)).size, live.length)
  for (const module of live) {
    const source = moduleSource(module.href)
    assert.doesNotMatch(source, /FeatureUnavailable/, `${module.href} must not be a placeholder`)
    assert.match(source, /PageHeader|<h1[\s>]/, `${module.href} needs a heading`)
  }
})

test('accessibility: one main landmark, skip link, viewport, labelled images, no positive tabindex', () => {
  const shell = read('components', 'layout', 'AdminShell.tsx')
  assert.match(shell, /href="#main-content"/)
  assert.match(shell, /<main id="main-content"/)
  assert.equal(shell.match(/<main[\s>]/g)?.length, 1)
  assert.doesNotMatch(read('app', '(dashboard)', 'dashboard', 'page.tsx'), /<main[\s>]/, 'the dashboard sits inside the shell main')
  assert.match(read('app', 'layout.tsx'), /width: 'device-width', initialScale: 1/)
  assert.match(read('components', 'layout', 'shell-theme.css'), /\.skip-link:focus/)
  assert.match(read('components', 'layout', 'shell-theme.css'), /:focus-visible/)
  assert.match(read('components', 'hotels', 'AuthImage.tsx'), /alt: string/)
  assert.match(read('components', 'hotels', 'AuthImage.tsx'), /alt=\{alt\}/)
  const ui = read('app', '(dashboard)', 'dashboard', 'page.tsx') + shell
  assert.doesNotMatch(ui, /tabIndex=\{[1-9]/)
})

test('responsive shell: mobile breakpoints collapse navigation and wide content scrolls inside main', () => {
  const css = read('app', 'globals.css') + read('components', 'layout', 'shell-theme.css') + read('components', 'layout', 'hotel-admin.css')
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /@media \(max-width: 600px\)/)
  assert.match(css, /main#main-content[\s\S]*overflow-x: auto/)
  assert.match(css, /mobile-nav-trigger/)
})

test('expired sessions show sign-in, keep no data, and cannot mutate', () => {
  assert.equal(classifyOpsFailure(new ApiResponseError('UNAUTHORIZED', 'x', 401)), 'unauthenticated')
  assert.match(OPS_FAILURE_COPY.unauthenticated.body, /session has expired/)
  assert.match(OPS_FAILURE_COPY.unauthenticated.body, /No data is shown/)
  assert.match(read('components', 'auth', 'AuthorizationStates.tsx'), /Sign-in required/)
  assert.match(read('components', 'auth', 'ServerLoadFailure.tsx'), /status === 401/)
  assert.match(read('lib', 'auth', 'session.ts'), /error\.status === 401/)
  assert.equal(decideAdminEdgeAccess({ pathname: '/hotels', sessionCookie: undefined }), 'login')
  assert.equal(decideAdminEdgeAccess({ pathname: '/hotels', sessionCookie: 'not-a-token' }), 'login')
  publishBrowserAuthGate({ status: 'error', tenantId: 't1', permissions: new Set(['supply.hotels.manage']) })
  assert.match(mutationBlockedReason('PATCH', 'supply.hotels.manage') ?? '', /Nothing was changed/)
  assert.equal(mutationBlockedReason('GET'), null)
})

test('tenant switching drops the previous permission set before any mutation', () => {
  assert.match(read('components', 'layout', 'AdminShell.tsx'), /RouteGuard key=\{activeTenantId/)
  assert.match(read('lib', 'auth', 'capabilities.tsx'), /publishBrowserAuthGate/)
  assert.match(read('lib', 'auth', 'capabilities.tsx'), /loadingCapabilities\(tenantId\)/)
  publishBrowserAuthGate({ status: 'loading', tenantId: 'next', permissions: new Set() })
  assert.ok(mutationBlockedReason('POST'))
  publishBrowserAuthGate({ status: 'ready', tenantId: 'next', permissions: new Set(['supply.hotels.read']) })
  assert.equal(mutationBlockedReason('GET'), null)
  assert.match(mutationBlockedReason('DELETE', 'supply.hotels.manage') ?? '', /do not have permission/)
  assert.equal(mutationBlockedReason('DELETE', 'supply.hotels.read'), null)
})

test('an API outage is unreachable, shows nothing, and does not confirm a malformed body', () => {
  assert.equal(classifyOpsFailure(new ApiResponseError('NETWORK_ERROR', 'x', 0)), 'unreachable')
  assert.equal(classifyOpsFailure(new ApiResponseError('API_TIMEOUT', 'x', 504)), 'unreachable')
  assert.match(OPS_FAILURE_COPY.unreachable.body, /Nothing is shown and nothing was changed/)
  assert.match(read('app', '(dashboard)', 'dashboard', 'page.tsx'), /API_/)
  assert.match(read('app', '(dashboard)', 'dashboard', 'page.tsx'), /AdminServiceUnavailable/)
  publishBrowserAuthGate({ status: 'error', tenantId: 't1', permissions: new Set() })
  assert.match(mutationBlockedReason('PUT') ?? '', /Nothing was changed/)
})

test('unauthorized routes and controls stay closed and cannot mutate', () => {
  const gated = live.filter((module) => module.requires)
  assert.ok(gated.length >= 37)
  for (const module of gated) {
    assert.equal(resolveRouteAccess(module.href, 'ready', () => false), 'denied', module.href)
    assert.equal(resolveRouteAccess(module.href, 'loading', () => true), 'checking', module.href)
    assert.equal(resolveRouteAccess(module.href, 'error', () => true), 'unavailable', module.href)
  }
  const guard = read('components', 'layout', 'RouteGuard.tsx')
  assert.ok(guard.indexOf("access === 'allow'") < guard.indexOf('{children}'))
  assert.match(guard, /You do not have permission to view this page/)
  assert.match(read('components', 'layout', 'Sidebar.tsx'), /!item\.requires \|\| can\(item\.requires\)/)
  const settings = read('app', '(dashboard)', 'settings', 'page.tsx')
  assert.ok(settings.indexOf("error === 'FORBIDDEN'") < settings.indexOf('type="submit"'))
  publishBrowserAuthGate({ status: 'ready', tenantId: 't1', permissions: new Set(['supply.rates.read']) })
  assert.equal(mutationBlockedReason('POST', 'supply.rates.manage'), 'You do not have permission to make this change. Nothing was changed.')
  assert.equal(mutationBlockedReason('POST', 'supply.rates.read'), null)
})
