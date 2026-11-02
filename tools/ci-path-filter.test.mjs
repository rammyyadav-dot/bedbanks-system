import assert from 'node:assert/strict'
import test from 'node:test'
import { classify, resolveRange } from './ci-path-filter.mjs'

test('docs-only changes skip expensive jobs', () => {
  assert.deepEqual(classify(['docs/runbooks/deploy.md', 'README.md']), {
    prisma: false, verify: false, e2e: false, website: false,
  })
})

test('API source turns on prisma certification, verify and e2e', () => {
  const flags = classify(['apps/api/src/agent/agent-search.service.ts'])
  assert.equal(flags.prisma, true)
  assert.equal(flags.verify, true)
  assert.equal(flags.e2e, true)
})

test('website-only changes skip API e2e and prisma certification', () => {
  assert.deepEqual(classify(['apps/website/app/page.tsx']), {
    prisma: false, verify: true, e2e: false, website: true,
  })
})

test('a ci.yml change forces every job', () => {
  assert.deepEqual(classify(['.github/workflows/ci.yml']), {
    prisma: true, verify: true, e2e: true, website: true,
  })
})

test('an empty diff (unknown range) forces every job', () => {
  assert.deepEqual(classify([]), { prisma: true, verify: true, e2e: true, website: true })
})

test('pull requests diff against the base branch', () => {
  assert.equal(resolveRange({ EVENT: 'pull_request', BASE_REF: 'main' }), 'origin/main...HEAD')
})

test('branch pushes diff against the previous SHA when it exists', () => {
  assert.equal(resolveRange({ EVENT: 'push', BEFORE: 'abc'.repeat(13) + 'abcd' }), `${'abc'.repeat(13)}abcd...HEAD`)
})
