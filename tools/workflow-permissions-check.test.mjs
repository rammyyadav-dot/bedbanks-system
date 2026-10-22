import assert from 'node:assert/strict'
import test from 'node:test'
import { check } from './workflow-permissions-check.mjs'

test('flags a workflow without a permissions block', () => assert.equal(check('a.yml', 'name: x\non: push\njobs: {}\n').length, 1))
test('accepts a read-only workflow', () => assert.deepEqual(check('a.yml', 'name: x\non: push\npermissions:\n  contents: read\njobs: {}\n'), []))
test('flags write-all', () => assert.equal(check('a.yml', 'permissions: write-all\n').length, 1))
test('flags pull_request_target', () => assert.equal(check('a.yml', 'on:\n  pull_request_target:\npermissions:\n  contents: read\n').length, 1))
test('flags an action pinned to a tag', () => assert.equal(check('a.yml', 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@v4\n').length, 1))
test('accepts SHA-pinned and local actions', () =>
  assert.deepEqual(check('a.yml', 'permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n      - uses: ./.github/actions/x\n'), []))
test('flags a floating runner image', () => assert.equal(check('a.yml', 'permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n').length, 1))
test('flags a service image without a digest', () => assert.equal(check('a.yml', 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 5\n    services:\n      redis:\n        image: redis:7-alpine\n').length, 1))
test('accepts a digest-pinned service image', () =>
  assert.deepEqual(check('a.yml', `permissions: {}\njobs:\n  a:\n    timeout-minutes: 5\n    services:\n      redis:\n        image: redis:7-alpine@sha256:${'a'.repeat(64)}\n`), []))
test('flags a job without timeout-minutes', () =>
  assert.deepEqual(check('a.yml', 'permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps: []\n  b:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n'), ['a.yml: job a has no timeout-minutes']))
