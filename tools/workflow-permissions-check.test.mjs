import assert from 'node:assert/strict'
import test from 'node:test'
import { check } from './workflow-permissions-check.mjs'

test('flags a workflow without a permissions block', () => assert.equal(check('a.yml', 'name: x\non: push\njobs: {}\n').length, 1))
test('accepts a read-only workflow', () => assert.deepEqual(check('a.yml', 'name: x\non: push\npermissions:\n  contents: read\njobs: {}\n'), []))
test('flags write-all', () => assert.equal(check('a.yml', 'permissions: write-all\n').length, 1))
test('flags pull_request_target', () => assert.equal(check('a.yml', 'on:\n  pull_request_target:\npermissions:\n  contents: read\n').length, 1))
