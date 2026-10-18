import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze } from './tenant-filter-check'

const run = (body: string) => analyze('/virtual/apps/api/src/x/x.service.ts', `class S { async m(tenantId: string, id: string) {\n${body}\n} }`)
const kinds = (body: string) => run(body).map((f) => `${f.kind}:${f.call}`)

test('a read, update or delete by id alone is a cross-tenant leak', () => {
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findFirst({ where: { id } }))'), ['missing-filter:booking.findFirst'])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.hotel.update({ where: { id }, data: {} }))'), ['missing-filter:hotel.update'])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.hotelImage.delete({ where: { id } }))'), ['missing-filter:hotelImage.delete'])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({}))'), ['missing-filter:booking.findMany'])
})

test('naming the tenant satisfies the rule: key, composite key, AND member, shorthand, resolved local', () => {
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findFirst({ where: { id, tenantId } }))'), [])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.membership.findUnique({ where: { userId_tenantId: { userId: id, tenantId } } }))'), [])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where: { AND: [{ id }, { tenantId }] } }))'), [])
  assert.deepEqual(kinds('const where = { id, tenantId }\nreturn this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where }))'), [])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where: cond ? { tenantId, id } : { tenantId } }))'), [])
})

test('a ternary where must name the tenant in both branches', () => {
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where: cond ? { tenantId, id } : { id } }))'), ['missing-filter:booking.findMany'])
})

test('a where built elsewhere cannot be verified; spreading it and pinning the tenant last can', () => {
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where: build(id) }))'), ['dynamic-where:booking.findMany'])
  assert.deepEqual(kinds('const where = build(id)\nreturn this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where }))'), ['dynamic-where:booking.findMany'])
  assert.deepEqual(kinds('const where = build(id)\nreturn this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where: { ...where, tenantId } }))'), [])
})

test('a tenant model queried on the bare service, outside a tenant transaction, is flagged even when it names the tenant', () => {
  assert.deepEqual(kinds('return this.prisma.booking.findMany({ where: { tenantId } })'), ['unscoped-client:booking.findMany'])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findMany({ where: { tenantId } }))'), [])
  assert.deepEqual(kinds('return this.prisma.withPlatform(id, (tx) => tx.booking.count({ where: { tenantId } }))'), [])
})

test('non-tenant models are not subject to the rule', () => {
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.user.findUnique({ where: { id } }))'), [])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.session.findFirst({ where: { id } }))'), [])
})

test('a nullable tenantId must be supplied explicitly on create, where the compiler would not force it', () => {
  assert.deepEqual(kinds('await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { action: "x", entityType: "y", entityId: id } }))'), ['missing-data:auditEvent.create'])
  assert.deepEqual(kinds('await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, action: "x", entityType: "y", entityId: id } }))'), [])
  assert.deepEqual(kinds('const data = { tenantId, action: "x" }\nawait this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data }))'), [])
  assert.deepEqual(kinds('await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.createMany({ data: [{ tenantId, action: "a" }, { action: "b" }] }))'), ['missing-data:auditEvent.createMany'])
})

test('compliance batches are tenant-scoped by scopeKey', () => {
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.complianceExportBatch.findFirst({ where: { scopeKey: tenantId } }))'), [])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.complianceExportBatch.findFirst({ where: { storageStatus: "SEALED" } }))'), ['missing-filter:complianceExportBatch.findFirst'])
  assert.deepEqual(kinds('return this.prisma.withTenant(tenantId, (tx) => tx.hotel.findFirst({ where: { scopeKey: tenantId } }))'), ['missing-filter:hotel.findFirst'])
})

test('raw SQL on a tenant table needs a tenant predicate; catalog probes and tenant-bound SQL pass', () => {
  assert.deepEqual(kinds('return tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${id} FOR UPDATE`'), ['raw-sql:$queryRaw'])
  assert.deepEqual(kinds('return tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${id} AND "tenant_id" = ${tenantId} FOR UPDATE`'), [])
  assert.deepEqual(kinds('return tx.$queryRawUnsafe(`SELECT * FROM "Booking" WHERE id = $1`, id)'), ['raw-sql:$queryRawUnsafe'])
  assert.deepEqual(kinds('return tx.$queryRaw`SELECT has_table_privilege(current_user, \'"Wallet"\', \'SELECT\')`'), [])
})

test('an audited waiver needs a real reason, on the same or the preceding line', () => {
  assert.deepEqual(kinds('// tenant-scope: platform directory is cross-tenant by design\nreturn this.prisma.withPlatform(id, (tx) => tx.booking.count({}))'), [])
  assert.deepEqual(kinds('return this.prisma.withPlatform(id, (tx) => tx.booking.count({})) // tenant-scope: cross-tenant by design'), [])
  assert.deepEqual(kinds('// tenant-scope: ok\nreturn this.prisma.withPlatform(id, (tx) => tx.booking.count({}))'), ['missing-filter:booking.count'])
  assert.deepEqual(kinds('// tenant-scope:\nreturn this.prisma.withPlatform(id, (tx) => tx.booking.count({}))'), ['missing-filter:booking.count'])
})

test('each finding reports the enclosing method for review', () => {
  const [finding] = run('return this.prisma.withTenant(tenantId, (tx) => tx.booking.findFirst({ where: { id } }))')
  assert.equal(finding.scope, 'S.m'); assert.equal(finding.line, 2)
})
