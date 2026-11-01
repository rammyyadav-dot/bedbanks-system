import { RuntimeRoleViolation, assertRuntimeDbIdentity, checkRuntimeUrl, describeDatabaseUrl, forbiddenUserReason, runtimeGuardMode, runtimeIdentityFailures, type RuntimeIdentity } from './runtime-db-identity'

const safe: RuntimeIdentity = { currentUser: 'fbeds_api_login', sessionUser: 'fbeds_api_login', superuser: false, bypassRls: false, createRole: false, createDb: false, replication: false, ownedObjects: 0, privilegedMemberships: [] }
const url = (user: string) => `postgresql://${user}:S3cr3t-Pass_word@db.example.test:5432/fbeds?sslmode=require`

describe('runtime database identity (P0-01, ADR 0040)', () => {
  it('RI-01: describes host, database and user and never the password', () => {
    const target = describeDatabaseUrl(url('fbeds_api_login'))
    expect(target).toEqual({ host: 'db.example.test', database: 'fbeds', user: 'fbeds_api_login' })
    expect(JSON.stringify(target)).not.toContain('S3cr3t')
  })

  it('RI-02: malformed or non-postgres URLs fail with a message that does not echo the input', () => {
    for (const bad of [undefined, 'not a url', 'mysql://u:SECRETVALUE@h/db']) {
      let message = ''
      try { describeDatabaseUrl(bad) } catch (error) { message = (error as Error).message }
      expect(message).not.toBe(''); expect(message).not.toContain('SECRETVALUE')
    }
  })

  it('RI-03: known owner and administrator logins are forbidden, restricted logins are not', () => {
    for (const user of ['postgres', 'neondb_owner', 'rdsadmin', 'admin', 'root', 'Postgres', 'fbeds_owner', 'app_owner', 'schema_migrator', 'db_admin']) expect(forbiddenUserReason(user)).not.toBeNull()
    for (const user of ['fbeds_api_login', 'fbeds_booking_ops', 'fbeds_hold_expiry_login']) expect(forbiddenUserReason(user)).toBeNull()
    expect(forbiddenUserReason('')).not.toBeNull()
  })

  it('RI-04: operators can extend the forbidden list per environment', () => {
    expect(forbiddenUserReason('svc_dba', { FBEDS_FORBIDDEN_RUNTIME_DB_USERS: 'svc_dba, other' })).not.toBeNull()
    expect(forbiddenUserReason('svc_dba', {})).toBeNull()
  })

  it('RI-05: checkRuntimeUrl accepts the restricted login and rejects the owner without leaking the password', () => {
    expect(checkRuntimeUrl(url('fbeds_api_login')).ok).toBe(true)
    const owner = checkRuntimeUrl(url('neondb_owner'))
    expect(owner.ok).toBe(false); expect(JSON.stringify(owner)).not.toContain('S3cr3t')
    expect(checkRuntimeUrl(undefined).ok).toBe(false)
  })

  it('RI-06: a restricted identity passes; every privileged attribute is its own named failure', () => {
    expect(runtimeIdentityFailures(safe)).toEqual([])
    expect(runtimeIdentityFailures({ ...safe, superuser: true })).toContain('role is SUPERUSER')
    expect(runtimeIdentityFailures({ ...safe, bypassRls: true })).toContain('role has BYPASSRLS')
    expect(runtimeIdentityFailures({ ...safe, createRole: true })).toContain('role has CREATEROLE')
    expect(runtimeIdentityFailures({ ...safe, createDb: true })).toContain('role has CREATEDB')
    expect(runtimeIdentityFailures({ ...safe, replication: true })).toContain('role has REPLICATION')
    expect(runtimeIdentityFailures({ ...safe, ownedObjects: 3 }).join()).toMatch(/owns database objects/)
    expect(runtimeIdentityFailures({ ...safe, privilegedMemberships: ['postgres'] }).join()).toMatch(/privileged roles: postgres/)
    expect(runtimeIdentityFailures({ ...safe, currentUser: 'neondb_owner' }).join()).toMatch(/known owner/)
    expect(runtimeIdentityFailures({ ...safe, sessionUser: 'postgres' }).join()).toMatch(/session database user/)
    expect(runtimeIdentityFailures(null)).toHaveLength(1)
  })

  it('RI-07: the assertion throws RuntimeRoleViolation naming the invariant, with no connection details', async () => {
    const db = { $queryRawUnsafe: async () => [{ current_user: 'postgres', session_user: 'postgres', rolsuper: true, rolbypassrls: true, rolcreaterole: true, rolcreatedb: true, rolreplication: false, owned: 12n, privileged: null }] as never }
    await expect(assertRuntimeDbIdentity(db, 'API')).rejects.toBeInstanceOf(RuntimeRoleViolation)
    await expect(assertRuntimeDbIdentity(db, 'API')).rejects.toThrow(/role is SUPERUSER; role has BYPASSRLS/)
    await expect(assertRuntimeDbIdentity(db, 'API')).rejects.not.toThrow(/postgresql:|password|@/i)
    const ok = { $queryRawUnsafe: async () => [{ current_user: 'fbeds_api_login', session_user: 'fbeds_api_login', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, owned: 0n, privileged: null }] as never }
    await expect(assertRuntimeDbIdentity(ok, 'API')).resolves.toMatchObject({ currentUser: 'fbeds_api_login', ownedObjects: 0 })
    await expect(assertRuntimeDbIdentity({ $queryRawUnsafe: async () => [] as never }, 'API')).rejects.toThrow(/could not be found/)
  })

  it('RI-08: the guard defaults to enforce and can only be switched off under NODE_ENV=test', () => {
    expect(runtimeGuardMode({})).toBe('enforce')
    expect(runtimeGuardMode({ DB_RUNTIME_ROLE_GUARD: 'enforce', NODE_ENV: 'production' })).toBe('enforce')
    expect(runtimeGuardMode({ DB_RUNTIME_ROLE_GUARD: 'off', NODE_ENV: 'test' })).toBe('off')
    for (const nodeEnv of ['production', 'staging', 'development', undefined]) expect(() => runtimeGuardMode({ DB_RUNTIME_ROLE_GUARD: 'off', NODE_ENV: nodeEnv })).toThrow(/only allowed when NODE_ENV=test/)
    expect(() => runtimeGuardMode({ DB_RUNTIME_ROLE_GUARD: 'maybe', NODE_ENV: 'test' })).toThrow(/must be "enforce"/)
  })
})
