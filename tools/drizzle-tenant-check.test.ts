import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkSource, scanRepository } from './drizzle-tenant-check'

test('a direct Drizzle client, a second pool and the serverless driver are rejected', () => {
  assert.match(checkSource('apps/api/src/other.ts', "import { drizzle } from 'drizzle-orm/node-postgres'")[0], /tenant-session/)
  assert.match(checkSource('apps/api/src/other.ts', 'const pool = new Pool({ connectionString })')[0], /TenantDrizzleService|tenant-drizzle/)
  assert.match(checkSource('apps/api/src/database/tenant-session.ts', "import { neon } from '@neondatabase/serverless'")[0], /serverless/)
  assert.deepEqual(checkSource('apps/api/src/database/tenant-session.ts', "import { drizzle } from 'drizzle-orm/node-postgres'"), [])
  assert.deepEqual(checkSource('apps/api/src/database/tenant-drizzle.service.ts', 'new Pool({ connectionString: url, max: 2 })'), [])
})

test('the repository keeps Drizzle behind the tenant hook', () => {
  assert.deepEqual(scanRepository(process.cwd()), [])
})
