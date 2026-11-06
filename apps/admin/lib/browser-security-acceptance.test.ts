import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { BOOKING_FINANCE_POSTING_UNAVAILABLE, liveDepartmentModules, OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { classifyOpsFailure, OPS_FAILURE_COPY } from './ops-state'
import { ApiResponseError } from './api/errors'
import { mutationBlockedReason, publishBrowserAuthGate } from './auth/mutation-gate'
import { resolveRouteAccess } from './auth/route-access'
import { decideAdminEdgeAccess } from './auth/edge-guard'
import { RouteError, routeErrorSupportRecord } from '../components/common/RouteError'
import { ServerLoadFailure } from '../components/auth/ServerLoadFailure'
import RootError from '../app/error'
import DashboardError from '../app/(dashboard)/error'
import GlobalError from '../app/global-error'

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

const SECRET = 'postgres://ops:s3cret@db.internal/fbeds Bearer eyJhbGciOi guest@example.com 4242424242424242'
const MARKUP = '</code><script>alert(1)</script><img src=x onerror=alert(1)>'

function shell(node: ReactNode): string {
  const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: '_b_0_' }
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, node))
}

function assertClosedFailure(html: string, label: string) {
  assert.equal(html.includes('s3cret'), false, label)
  assert.equal(html.includes('eyJhbGciOi'), false, label)
  assert.equal(html.includes('guest@example.com'), false, label)
  assert.equal(html.includes('4242424242424242'), false, label)
  assert.doesNotMatch(html, /<script\b|<img\b/i, label)
  assert.doesNotMatch(html, /<form[\s>]|type="submit"|<table[\s>]/, label)
  assert.match(html, /role="alert"/, label)
}

function poisoned(digest = 'opaque-digest-9'): Error & { digest?: string } {
  return Object.assign(new Error(SECRET), { digest, stack: `at leak (${SECRET})`, cause: new Error(SECRET), token: SECRET })
}

test('route error boundaries show only an opaque digest and log no thrown detail', () => {
  const error = poisoned(`${MARKUP}opaque`)
  const record = routeErrorSupportRecord(error)
  assert.deepEqual(record, { level: 'error', event: 'admin_route_error', digest: error.digest, name: 'Error' })
  assert.equal(JSON.stringify(record).includes('s3cret'), false)
  assert.match(read('components', 'common', 'RouteError.tsx'), /JSON\.stringify\(routeErrorSupportRecord\(error\)\)/)
  const root = shell(createElement(RootError, { error, reset() {} }))
  const dashboard = shell(createElement(DashboardError, { error, reset() {} }))
  const global = renderToStaticMarkup(createElement(GlobalError, { error, reset() {} }))
  for (const [label, html] of [['root', root], ['dashboard', dashboard], ['global', global]] as const) {
    assertClosedFailure(html, label)
    assert.match(html, /Nothing was changed/, label)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, label)
    assert.match(html, /opaque/, label)
    assert.match(html, /\bRetry</, label)
  }
  assert.match(root, /Something went wrong/)
  assert.doesNotMatch(root, /Back to dashboard/)
  assert.match(dashboard, /href="\/dashboard"/)
  assert.match(dashboard, /Back to dashboard/)
  assert.match(global, /The Admin Console could not load/)
  const quiet = shell(createElement(RouteError, { error: new Error(SECRET), reset() {} }))
  assertClosedFailure(quiet, 'no digest')
  assert.doesNotMatch(quiet, /Reference:/)
})

test('a failed server load renders sign-in, denial, or a closed retry — never the payload or an empty list', () => {
  const pages = ['roles', 'permissions', 'assignments']
  for (const page of pages) {
    const source = read('app', '(dashboard)', 'access', page, 'page.tsx')
    assert.match(source, /<ServerLoadFailure /, page)
    assert.doesNotMatch(source, /error\.message|error\.stack|error\.details/, page)
  }
  const leak = new ApiResponseError('INTERNAL', SECRET, 500, `req-9${MARKUP}`, [`detail ${SECRET}`])
  const cases: Array<[string, unknown, RegExp, RegExp?]> = [
    ['401', new ApiResponseError('UNAUTHORIZED', SECRET, 401, 'req-auth'), /Sign-in required/, /Reference:|Retry/],
    ['403', new ApiResponseError('FORBIDDEN', SECRET, 403, 'req-deny', [SECRET]), /finance\.ledger\.read/, /Reference:|Retry/],
    ['500', leak, /Could not load this view[\s\S]*INTERNAL \(HTTP 500\) · request req-9/, /s3cret/],
    ['unreachable', new ApiResponseError('NETWORK_ERROR', SECRET, 0), /Nothing is shown and nothing was changed/, undefined],
    ['denied', new ApiResponseError(OPERATIONS_READ_DENIED, SECRET, 503, 'req-denied'), /not an empty result/, undefined],
    ['not-configured', new ApiResponseError(BOOKING_FINANCE_POSTING_UNAVAILABLE, SECRET, 503), /Nothing was changed/, undefined],
    ['plain', new Error(SECRET), /No fallback data is shown/, /Reference:/],
  ]
  for (const [label, error, expected, absent] of cases) {
    const html = shell(createElement(ServerLoadFailure, { error, title: 'Ledger adjustments', permission: 'finance.ledger.read', subject: 'ledger adjustments' }))
    assertClosedFailure(html, label)
    assert.match(html, expected, label)
    if (label === '401' || label === '403') assert.doesNotMatch(html, /Unable to load|Ledger adjustments/, label)
    else assert.match(html, /Unable to load ledger adjustments/, label)
    if (label !== '401' && label !== '403') assert.match(html, /\bRetry</, label)
    if (absent) assert.doesNotMatch(html, absent, label)
    if (label === '500') assert.match(html, /&lt;script&gt;/, label)
  }
})
