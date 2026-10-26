import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

test('every boundary level exists: root, dashboard, global', () => {
  for (const file of [['app', 'error.tsx'], ['app', 'global-error.tsx'], ['app', '(dashboard)', 'error.tsx'], ['app', '(dashboard)', 'loading.tsx'], ['app', '(dashboard)', 'not-found.tsx']]) {
    assert.ok(existsSync(join(root, ...file)), `${file.join('/')} is missing`)
  }
  assert.match(read('app', 'error.tsx'), /^'use client'/)
  assert.match(read('app', '(dashboard)', 'error.tsx'), /^'use client'/)
})

test('route errors show only the opaque digest, never the thrown message', () => {
  const src = read('components', 'common', 'RouteError.tsx')
  assert.match(src, /error\.digest/)
  assert.doesNotMatch(src, /\{error\.message\}|error\.stack/)
  assert.match(read('app', 'global-error.tsx'), /error\.digest/)
  assert.doesNotMatch(read('app', 'global-error.tsx'), /error\.message/)
})

test('a failed server load offers retry and a support reference, and is never shown as empty', () => {
  const src = read('components', 'auth', 'ServerLoadFailure.tsx')
  assert.match(src, /<RetryButton/)
  assert.match(src, /failureReference\(error\)/)
  assert.match(src, /status === 403/)
})

test('contracts are paged, filtered and sorted by the API, not in the browser', () => {
  const page = read('app', '(dashboard)', 'contracts', 'page.tsx')
  assert.match(page, /getContractPortfolio/)
  assert.doesNotMatch(page, /getContracts\(|\.filter\(/, 'no unbounded fetch or in-memory filtering')
  const list = read('components', 'ops', 'OpsListPage.tsx')
  assert.match(list, /sortBy/)
  assert.match(list, /aria-sort/)
})

test('cookie names come from one server-env source', () => {
  assert.doesNotMatch(read('lib', 'auth', 'session.ts'), /process\.env/)
  assert.doesNotMatch(read('lib', 'auth', 'actions.ts'), /process\.env/)
})
