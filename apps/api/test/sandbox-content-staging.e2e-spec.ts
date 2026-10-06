import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { SandboxContentStore, sandboxStagingGrantSql, verifySandboxStagingPrincipal, SANDBOX_STAGING_GROUP } from '../src/sandbox/sandbox-content-store'

const url = process.env.DATABASE_URL
if (!url) throw new Error('Disposable PostgreSQL DATABASE_URL is required')
const parsed = new URL(url)
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/fbeds_ci') throw new Error('Only local fbeds_ci is allowed')

describe('sandbox staging on a non-owner, non-BYPASSRLS PostgreSQL principal', () => {
  const owner = new PrismaClient({ datasourceUrl: url })
  const suffix = randomBytes(8).toString('hex')
  const role = `sandbox_${suffix}`
  const tenantId = `sandbox_${suffix}`
  let probe: PrismaClient
  let store: SandboxContentStore
  let supplierId: string, connectorId: string
  let token: string
  const runId = `run_${suffix}`
  let scope: { tenantId: string; supplierId: string; connectorId: string; correlationId: string }
  let key: string
  beforeAll(async () => {
    await owner.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Sandbox staging evidence' } })
    const supplier = await owner.supplier.create({ data: { tenantId, type: 'BEDBANK', legalName: 'Sandbox', displayName: 'Sandbox', countryCode: 'AE', defaultCurrency: 'AED' } })
    supplierId = supplier.id
    const connector = await owner.connectorDefinition.create({ data: { tenantId, supplierId, type: 'API_JSON', name: suffix, version: '1', transportMetadata: { environment: 'sandbox', provider: 'hotelbeds' } } })
    connectorId = connector.id
    const password = randomBytes(24).toString('hex')
    await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)
    await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SANDBOX_STAGING_GROUP}') THEN CREATE ROLE "${SANDBOX_STAGING_GROUP}" NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
    await owner.$executeRawUnsafe(`GRANT "${SANDBOX_STAGING_GROUP}" TO "${role}"`)
    for (const sql of sandboxStagingGrantSql(role)) await owner.$executeRawUnsafe(sql)
    const loginUrl = new URL(url!)
    loginUrl.username = role; loginUrl.password = password
    probe = new PrismaClient({ datasourceUrl: loginUrl.toString() })
    await verifySandboxStagingPrincipal(probe)
    scope = { tenantId, supplierId, connectorId, correlationId: `request_${suffix}` }
    store = new SandboxContentStore(probe, scope)
    key = `fbeds:sandbox-content:${tenantId}:${supplierId}:${connectorId}`
  })
  afterAll(async () => {
    await probe?.$disconnect()
    await owner.sandboxContentPage.deleteMany({ where: { tenantId } })
    await owner.sandboxContentRun.deleteMany({ where: { tenantId } })
    await owner.sandboxContentLease.deleteMany({ where: { tenantId } })
    await owner.auditEvent.deleteMany({ where: { tenantId } })
    await owner.connectorDefinition.deleteMany({ where: { tenantId } })
    await owner.supplier.deleteMany({ where: { tenantId } })
    await owner.tenant.deleteMany({ where: { id: tenantId } })
    await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`)
    await owner.$executeRawUnsafe(`DROP ROLE "${role}"`)
    await owner.$disconnect()
  })
  it('allows exactly one concurrent lease and rejects stale checkpoint writers', async () => {
    const results = await Promise.all([store.acquire(key, 60000), store.acquire(key, 60000)])
    expect(results.filter(Boolean)).toHaveLength(1)
    token = results.find(Boolean)!.token
    await expect(store.checkpoint(scope, runId, null, 'wrong-token')).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(await store.checkpoint(scope, runId, null, token)).toBe(1)
  })
  it('atomically stages and replays a page without duplicated audit or progress', async () => {
    const page = { runId, lastUpdateTime: null, leaseToken: token, expectedFrom: 1, nextFrom: 101, hotels: [{ code: 3424, name: 'Sandbox fixture' }], receivedAt: new Date().toISOString() }
    await store.commitPage(scope, page)
    await store.commitPage(scope, page)
    expect(await owner.sandboxContentPage.count({ where: { tenantId } })).toBe(1)
    expect(await owner.auditEvent.count({ where: { tenantId, action: 'sandbox.content.page_staged' } })).toBe(1)
    await expect(store.commitPage(scope, { ...page, hotels: [{ code: 3425 }] })).rejects.toMatchObject({ code: 'PAGE_CONFLICT' })
    expect((await owner.sandboxContentRun.findUniqueOrThrow({ where: { id: runId } })).nextFrom).toBe(101)
  })
  it('fails closed for absent tenant context and protected page mutation', async () => {
    expect(await probe.sandboxContentPage.count()).toBe(0)
    await expect(probe.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
      await tx.$executeRaw`UPDATE "SandboxContentPage" SET "next_from" = 999 WHERE "tenant_id" = ${tenantId}`
    })).rejects.toThrow()
    await expect(probe.$executeRaw`UPDATE "InventoryPoolDay" SET "sold" = 0`).rejects.toThrow()
    expect(await probe.sandboxContentPage.count()).toBe(0)
  })
  it('rejects expired finish and resumes the committed checkpoint with immutable parameters', async () => {
    await owner.sandboxContentLease.updateMany({ where: { tenantId }, data: { expiresAt: new Date(0) } })
    await expect(store.finish(scope, { runId, complete: true, leaseToken: token })).rejects.toMatchObject({ code: 'LEASE_LOST' })
    const lease = await store.acquire(key, 60000)
    expect(lease).not.toBeNull()
    await expect(store.checkpoint(scope, runId, '2026-10-05', lease!.token)).rejects.toMatchObject({ code: 'PARAMETER_CONFLICT' })
    expect(await store.checkpoint(scope, runId, null, lease!.token)).toBe(101)
    await store.finish(scope, { runId, complete: false, leaseToken: lease!.token })
    await store.release(lease!)
  })
})
