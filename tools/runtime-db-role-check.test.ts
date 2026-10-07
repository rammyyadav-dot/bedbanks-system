import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { APPROVED_CLIENTS, checkClientSource, checkConfigText, scanRepository } from './runtime-db-role-check'

const SECRET = 'S3cr3t-Pass_word'
const service = { disposable: false, serviceDefinition: true }

test('a runtime service configured with the migration owner is a violation, without printing the password', () => {
  const out = checkConfigText('render.yaml', `DATABASE_URL: postgresql://neondb_owner:${SECRET}@ep-x.neon.tech/db`, service)
  assert.equal(out.length, 1); assert.match(out[0], /neondb_owner/); assert.ok(!out[0].includes(SECRET))
  assert.equal(checkConfigText('r', `BOOKING_OPS_DATABASE_URL=postgresql://postgres:${SECRET}@h/db`, service).length, 1)
  assert.equal(checkConfigText('r', `HOLD_EXPIRY_DATABASE_URL=postgresql://admin:${SECRET}@h/db`, service).length, 1)
})

test('the restricted logins and secret references are accepted', () => {
  assert.deepEqual(checkConfigText('r', `DATABASE_URL: postgresql://fbeds_api_login:${SECRET}@h/db`, service), [])
  assert.deepEqual(checkConfigText('r', 'DATABASE_URL: ${{ secrets.DATABASE_URL }}', service), [])
})

test('owner-only variables may not appear in a service definition, but a template comment-free file without them passes', () => {
  for (const name of ['MIGRATION_DATABASE_URL', 'PROVISION_DATABASE_URL', 'OWNER_DATABASE_URL', 'DIRECT_URL']) assert.equal(checkConfigText('Dockerfile', `ENV ${name}=x`, service).length, 1)
  assert.deepEqual(checkConfigText('Dockerfile', 'ENV DATABASE_URL_UNPOOLEDX=1 NODE_ENV=production', service), [])
})

test('a disposable local CI database may use its throwaway owner; a remote one may not', () => {
  const ci = { disposable: true, serviceDefinition: false }
  assert.deepEqual(checkConfigText('ci.yml', `DATABASE_URL: postgresql://postgres:postgres@localhost:5432/fbeds_ci`, ci), [])
  assert.equal(checkConfigText('ci.yml', `DATABASE_URL: postgresql://postgres:${SECRET}@db.example.test:5432/x`, ci).length, 1)
})

test('an unlisted PrismaClient is a violation; the audited sites are not', () => {
  assert.equal(checkClientSource('apps/api/src/new/thing.ts', 'const p = new PrismaClient()').length, 1)
  assert.equal(checkClientSource('apps/api/src/new/thing.ts', 'class X extends PrismaClient {}').length, 1)
  assert.deepEqual(checkClientSource(APPROVED_CLIENTS[0].file, 'class X extends PrismaClient {}'), [])
  assert.deepEqual(checkClientSource('apps/api/src/new/thing.ts', 'const p = new PrismaService()'), [])
})

test('scanning a repository finds an owner in render.yaml, a rogue client and a frontend prisma import', () => {
  const root = mkdtempSync(join(tmpdir(), 'rdbc-'))
  mkdirSync(join(root, 'apps/api/src'), { recursive: true }); mkdirSync(join(root, 'apps/admin/lib'), { recursive: true })
  writeFileSync(join(root, 'render.yaml'), `envVars:\n  - key: DATABASE_URL\n    value: postgresql://postgres:${SECRET}@h/db\n`)
  writeFileSync(join(root, 'apps/api/src/rogue.ts'), 'export const p = new PrismaClient()')
  writeFileSync(join(root, 'apps/admin/lib/db.ts'), "import { PrismaClient } from '@prisma/client'")
  const { violations } = scanRepository(root)
  assert.ok(violations.some((v) => v.startsWith('render.yaml')) && violations.some((v) => v.includes('rogue.ts')) && violations.some((v) => v.includes('only the API may import')))
  assert.ok(violations.every((v) => !v.includes(SECRET)))
})

test('this repository passes', () => { assert.deepEqual(scanRepository(process.cwd()).violations, []) })
