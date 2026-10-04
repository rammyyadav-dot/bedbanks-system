import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVILEGED_WRITE_MODELS, RUNTIME_ROLE_GRANTS, expectedWrites, renderRuntimeRoleMatrix, runtimeGrantStatements, type WritePrivilege } from './runtime-role-contract'

const root = join(__dirname, '..', '..')
const repo = join(root, '..', '..')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')

/** model name -> table name, from prisma/schema.prisma (@@map). */
function schemaModels(): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of read(root, 'prisma', 'schema.prisma').matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) out.set(match[1], /@@map\("([^"]+)"\)/.exec(match[2])?.[1] ?? match[1])
  return out
}
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.ts$/.test(name) && !/\.spec\.ts$|\.cli\.ts$|bootstrap-first-admin|\.d\.ts$/.test(name) ? [full] : []
  })
}

describe('API runtime role contract (the single definition)', () => {
  const models = schemaModels()
  const byTable = new Map(RUNTIME_ROLE_GRANTS.map((g) => [g.table, g]))

  it('names real tables and models, once each', () => {
    expect(byTable.size).toBe(RUNTIME_ROLE_GRANTS.length)
    const tables = new Set(models.values())
    for (const grant of RUNTIME_ROLE_GRANTS) {
      expect({ table: grant.table, exists: tables.has(grant.table) }).toEqual({ table: grant.table, exists: true })
      expect({ model: grant.model, table: models.get(grant.model) }).toEqual({ model: grant.model, table: grant.table })
    }
    for (const model of Object.keys(PRIVILEGED_WRITE_MODELS)) expect({ model, exists: models.has(model) }).toEqual({ model, exists: true })
  })

  it('documents every write: service, endpoints and reason; and a writable table is always readable', () => {
    for (const grant of RUNTIME_ROLE_GRANTS) for (const write of grant.writes) {
      expect({ table: grant.table, op: write.op, ok: write.service.length > 0 && write.endpoints.length > 0 && write.reason.length > 10 }).toEqual({ table: grant.table, op: write.op, ok: true })
      if (grant.writes.length) expect({ table: grant.table, read: grant.read }).toEqual({ table: grant.table, read: true })
    }
  })

  it('every writable tenant table has forced row-level security declared (a privilege never replaces RLS)', () => {
    for (const grant of RUNTIME_ROLE_GRANTS.filter((g) => g.writes.length)) {
      if (grant.rls === 'none') expect(['users', 'sessions']).toContain(grant.table)
    }
  })

  it('never grants a privileged path at table level, never DELETE on audit, never any write to the finance, booking or journal tables', () => {
    const tableLevel = (grant: { writes: readonly { columns?: readonly string[] }[] }) => grant.writes.some((w) => !w.columns)
    for (const [model] of Object.entries(PRIVILEGED_WRITE_MODELS)) {
      const table = models.get(model)!
      const grant = byTable.get(table)
      if (grant && tableLevel(grant)) expect({ model, tableLevel: true }).toEqual({ model, tableLevel: false })
    }
    expect(byTable.get('AuditEvent')!.writes.map((w) => w.op)).toEqual(['INSERT'])
    for (const table of ['Wallet', 'LedgerEntry', 'Booking', 'BookingDocument', 'InventoryHold', 'InventoryHoldNight', 'SupplierMutation', 'RoomAmenity', 'ConnectorCredentialReference']) expect(byTable.has(table)).toBe(false)
  })

  it('every runtime write in the source tree is either in the contract or a listed privileged path, and every granted write has a call site (necessity)', () => {
    const delegates = new Map([...models.keys()].map((m) => [m.charAt(0).toLowerCase() + m.slice(1), m]))
    const ops = new Map<string, Set<WritePrivilege>>()
    const add = (model: string, op: WritePrivilege) => ops.set(model, (ops.get(model) ?? new Set()).add(op))
    const OP: Record<string, WritePrivilege[]> = { create: ['INSERT'], createMany: ['INSERT'], update: ['UPDATE'], updateMany: ['UPDATE'], upsert: ['INSERT', 'UPDATE'], delete: ['DELETE'], deleteMany: ['DELETE'] }
    const tableToModel = new Map([...models].map(([m, t]) => [t, m]))
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\.([a-z][A-Za-z0-9]*)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)) {
        const model = delegates.get(m[1]); if (model) for (const op of OP[m[2]]) add(model, op)
      }
      for (const m of text.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+"([A-Za-z_]+)"/g)) {
        const model = tableToModel.get(m[2]); if (!model) continue
        add(model, m[1] === 'INSERT INTO' ? 'INSERT' : m[1] === 'UPDATE' ? 'UPDATE' : 'DELETE')
      }
    }
    const granted = new Set(RUNTIME_ROLE_GRANTS.filter((g) => g.writes.length).map((g) => g.model))
    const unclassified = [...ops.keys()].filter((model) => !granted.has(model) && !(model in PRIVILEGED_WRITE_MODELS)).sort()
    expect({ unclassified }).toEqual({ unclassified: [] })
    for (const grant of RUNTIME_ROLE_GRANTS.filter((g) => g.writes.length)) {
      const used = ops.get(grant.model) ?? new Set()
      for (const write of grant.writes) expect({ table: grant.table, op: write.op, hasCallSite: used.has(write.op) }).toEqual({ table: grant.table, op: write.op, hasCallSite: true })
    }
  })

  it('the privilege matrix in docs/strict-runtime-db-role.md is the one generated from this module', () => {
    const doc = read(repo, 'docs', 'strict-runtime-db-role.md')
    const block = /<!-- BEGIN GENERATED: runtime-role-matrix -->\n([\s\S]*?)\n<!-- END GENERATED: runtime-role-matrix -->/.exec(doc)?.[1]
    expect(block).toBe(renderRuntimeRoleMatrix())
  })

  it('the forward migration that sets the write set equals what this module generates', () => {
    const sql = read(root, 'prisma', 'migrations', '202610180001_strict_runtime_role_write_set', 'migration.sql')
    const actual = [...sql.matchAll(/EXECUTE '([^']+)';/g)].map((m) => m[1])
    const tables = [...new Set(actual.map((s) => /ON "([^"]+)"/.exec(s)![1]))]
    const grants = runtimeGrantStatements('fbeds_api').filter((s) => s.startsWith('GRANT') && !s.startsWith('GRANT USAGE')).map((s) => s.replace(/"fbeds_api"/g, 'fbeds_api'))
    const expected = tables.flatMap((t) => [`REVOKE ALL ON "${t}" FROM fbeds_api`, ...grants.filter((s) => s.includes(` ON "${t}" TO `))])
    expect(actual).toEqual(expected)
    // The migration covers every table an earlier migration ever granted the runtime role.
    const granted = new Set<string>()
    const dir = join(root, 'prisma', 'migrations')
    for (const name of readdirSync(dir).filter((n) => n < '202610180001')) {
      const file = join(dir, name, 'migration.sql'); if (!statSync(join(dir, name)).isDirectory()) continue
      for (const m of read(file).replace(/--[^\n]*/g, '').matchAll(/GRANT [^;]*? ON "([^"]+)" TO fbeds_api/g)) granted.add(m[1])
    }
    for (const table of granted) {
      if (['HotelSearchIndex', 'supplier_memberships', 'supplier_room_drafts'].includes(table)) continue // untouched: identical to the contract already
      expect({ table, covered: tables.includes(table) }).toEqual({ table, covered: true })
    }
  })

  it('expectedWrites is consistent with the statements', () => {
    const statements = runtimeGrantStatements('fbeds_api').join('\n')
    for (const [table, want] of expectedWrites()) {
      for (const op of want.table) expect(statements).toMatch(new RegExp(`GRANT [A-Z, ]*${op}[A-Z, ]* ON "${table}"`))
      for (const op of want.columns.keys()) expect(statements).toContain(`GRANT ${op} (`)
    }
  })
})
