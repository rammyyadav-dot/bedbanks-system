import assert from 'node:assert/strict'
import test from 'node:test'
import { check, satisfies } from './framework-peer-check.mjs'

const lock = (swaggerVersion, peerRange) => `lockfileVersion: '9.0'

packages:

  '@nestjs/common@11.2.7':
    resolution: {integrity: sha512-x}
    peerDependencies:
      class-transformer: '>=0.4.1'

  '@nestjs/core@11.2.7':
    resolution: {integrity: sha512-x}
    peerDependencies:
      '@nestjs/common': ^11.0.0

  '@nestjs/swagger@${swaggerVersion}':
    resolution: {integrity: sha512-x}
    peerDependencies:
      '@nestjs/common': ${peerRange}
      '@nestjs/core': ${peerRange}
      reflect-metadata: ^0.1.12 || ^0.2.0

snapshots:

  '@nestjs/swagger@${swaggerVersion}(@nestjs/common@12.0.0)':
    dependencies: {}
`

test('accepts swagger 11 beside Nest 11', () => assert.deepEqual(check(lock('11.4.7', '^11.0.1')), []))
test('flags swagger 12 beside Nest 11 (audit B2)', () => {
  const problems = check(lock('12.0.0', '^12.0.0'))
  assert.equal(problems.length, 2)
  assert.match(problems[0], /@nestjs\/swagger@12\.0\.0 needs @nestjs\/common \^12\.0\.0 but 11\.2\.7/)
})
test('ignores the snapshots section', () => assert.deepEqual(check(lock('11.4.7', '^10.0.0 || ^11.0.0')), []))
test('flags two framework versions in one lockfile', () => assert.equal(check(`packages:\n\n  '@nestjs/core@11.2.7':\n    resolution: {}\n\n  '@nestjs/core@12.0.0':\n    resolution: {}\n`).length, 1))

test('satisfies handles the ranges Nest packages publish', () => {
  assert.ok(satisfies('11.2.7', '^10.0.0 || ^11.0.0'))
  assert.ok(!satisfies('11.2.7', '^12.0.0'))
  assert.ok(satisfies('0.2.2', '^0.1.12 || ^0.2.0'))
  assert.ok(!satisfies('0.3.0', '^0.2.0'))
  assert.ok(satisfies('5.9.3', '>=4.8.2'))
  assert.ok(satisfies('11.2.7', '11.x'))
  assert.ok(!satisfies('11.2.7', '~11.1.0'))
  assert.ok(satisfies('1.0.0', '*'))
})
