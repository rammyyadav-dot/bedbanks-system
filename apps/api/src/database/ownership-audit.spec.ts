import { RLS_EXEMPT_TABLES, runtimeOwnershipAudit } from './ownership-audit'
import { RUNTIME_ROLE_GRANTS } from './runtime-role-contract'

type Row = { schema: string; tbl: string; owner: string; rls: boolean; forced: boolean; privs: Array<string | null> }
const fake = (rows: Row[], caps = { schema_create: false, db_create: false }) => ({ $queryRawUnsafe: async (sql: string) => (sql.includes('has_schema_privilege') ? [caps] : rows)  as never })
const forced = (tbl: string, privs: Array<string | null> = ['SELECT'], owner = 'migrator'): Row => ({ schema: 'public', tbl, owner, rls: true, forced: true, privs })

describe('runtime ownership audit (P0-01)', () => {
  it('OA-01: a clean database passes and counts forced and exempt tables', async () => {
    const a = await runtimeOwnershipAudit(fake([forced('Hotel'), { schema: 'public', tbl: 'PlatformRole', owner: 'migrator', rls: false, forced: false, privs: [] }]), { migrationOwner: 'migrator' })
    expect(a.failures).toEqual([]); expect(a).toMatchObject({ tables: 2, forcedTables: 1, exemptTables: 1, owners: ['migrator'] })
    expect(a.rows[1].exempt).toMatch(/platform/i)
  })
  it('OA-02: runtime-owned tables, an unexplained non-forced table and a stray privilege on an exempt table each fail', async () => {
    const a = await runtimeOwnershipAudit(fake([forced('Hotel', ['SELECT'], 'fbeds_api_login'), { schema: 'public', tbl: 'Mystery', owner: 'migrator', rls: false, forced: false, privs: [] }, { schema: 'public', tbl: 'PlatformRole', owner: 'migrator', rls: false, forced: false, privs: ['SELECT'] }]), { migrationOwner: 'migrator' })
    expect(a.failures.join('\n')).toMatch(/Hotel is owned by runtime role fbeds_api_login/)
    expect(a.failures.join('\n')).toMatch(/Mystery has no FORCE ROW LEVEL SECURITY and no documented exemption/)
    expect(a.failures.join('\n')).toMatch(/PlatformRole is exempt from RLS as a non-tenant table but the runtime group holds SELECT/)
  })
  it('OA-03: TRUNCATE/REFERENCES/TRIGGER, schema CREATE and database CREATE fail; a non-owner table fails when an owner is expected', async () => {
    const a = await runtimeOwnershipAudit(fake([forced('Hotel', ['SELECT', 'TRUNCATE'], 'someone_else')], { schema_create: true, db_create: true }), { migrationOwner: 'migrator' })
    expect(a.failures.join('\n')).toMatch(/holds TRUNCATE/); expect(a.failures.join('\n')).toMatch(/CREATE in schema public/); expect(a.failures.join('\n')).toMatch(/CREATE schemas/); expect(a.failures.join('\n')).toMatch(/not the migration owner/)
  })
  it('OA-04: an exemption that is not in the grant contract (or is forced) is flagged, and every per-contract exemption is a contract table', async () => {
    for (const [table, e] of Object.entries(RLS_EXEMPT_TABLES)) if (e.runtimePrivileges === 'per-contract') expect(RUNTIME_ROLE_GRANTS.some((g) => g.table === table)).toBe(true)
    const a = await runtimeOwnershipAudit(fake([forced('users')]), { migrationOwner: 'migrator' })
    expect(a.failures.join('\n')).toMatch(/users is listed as RLS-exempt but has forced RLS/)
  })
})
