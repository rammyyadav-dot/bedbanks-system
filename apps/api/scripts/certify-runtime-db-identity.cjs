// Engineering-only certification of runtime-db-identity.ts (P0-01, ADR 0040) against REAL role fixtures on the
// disposable PostgreSQL service declared in CI. Unlike runtime-db-identity.spec.ts (pure, shaped-row fixtures),
// this creates actual roles and grants so that reachable ownership and privilege paths - including role
// membership with and without INHERIT, and an active SET ROLE - are detected by Postgres itself, not guessed at.
// Owner connection provisions/tears down fixtures; every identity read reconnects as the fixture login, never the owner.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { assertRuntimeDbIdentity, runtimeIdentityFailures } = require('../src/database/runtime-db-identity')

const SUFFIX = randomUUID().replace(/-/g, '_').slice(0, 12)
const OWNER_ROLE = `rtid_owner_role_${SUFFIX}`
const TABLE = `rtid_owned_table_${SUFFIX}`
const BARE_LOGIN = `rtid_bare_login_${SUFFIX}`
const INHERIT_LOGIN = `rtid_inherit_login_${SUFFIX}`
const NOINHERIT_LOGIN = `rtid_noinherit_login_${SUFFIX}`
const PASSWORD = randomUUID()

async function identityAs(url, username) {
  const target = new URL(url)
  target.username = username
  target.password = PASSWORD
  const db = new PrismaClient({ datasourceUrl: target.toString() })
  try {
    const [row] = await db.$queryRawUnsafe(`SELECT current_user AS u`)
    assert.equal(row.u, username, `connected as ${username}`)
    return await assertRuntimeDbIdentity(db, `fixture:${username}`).then((identity) => ({ identity, error: null })).catch((error) => ({ identity: null, error }))
  } finally {
    await db.$disconnect()
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable GitHub Actions service required')
  assert.equal(process.env.NODE_ENV, 'test', 'Test environment required')
  const url = process.env.DATABASE_URL
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Loopback database required')

  const owner = new PrismaClient({ datasourceUrl: url })
  try {
    await owner.$executeRawUnsafe(`CREATE ROLE "${OWNER_ROLE}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
    await owner.$executeRawUnsafe(`CREATE TABLE "${TABLE}" (id int)`)
    await owner.$executeRawUnsafe(`ALTER TABLE "${TABLE}" OWNER TO "${OWNER_ROLE}"`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${BARE_LOGIN}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${PASSWORD}'`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${INHERIT_LOGIN}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${PASSWORD}'`)
    await owner.$executeRawUnsafe(`GRANT "${OWNER_ROLE}" TO "${INHERIT_LOGIN}" WITH INHERIT TRUE`)
    await owner.$executeRawUnsafe(`CREATE ROLE "${NOINHERIT_LOGIN}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '${PASSWORD}'`)
    await owner.$executeRawUnsafe(`GRANT "${OWNER_ROLE}" TO "${NOINHERIT_LOGIN}" WITH INHERIT FALSE`)

    // RI-FIX-01: a restricted login with no membership and no ownership passes outright.
    const bare = await identityAs(url, BARE_LOGIN)
    assert.equal(bare.error, null, `bare restricted login must pass: ${bare.error?.message}`)
    assert.equal(bare.identity.ownedObjects, 0)
    assert.deepEqual(bare.identity.privilegedMemberships, [])

    // RI-FIX-02: INHERIT membership in an ordinary object-owner role grants automatic ownership-equivalent
    // privileges (Postgres ownership checks test has_privs_of_role, not literal relowner equality) - this
    // must be rejected even though the owner role itself has no SUPERUSER/BYPASSRLS/CREATEROLE flag.
    const inherited = await identityAs(url, INHERIT_LOGIN)
    assert.ok(inherited.error, 'INHERIT member of an object-owner role must be rejected')
    assert.match(inherited.error.message, /owns database objects/)

    // RI-FIX-03: a NOINHERIT membership grants no automatic privilege, but the login can still issue
    // SET ROLE to assume the owner role's powers at will - this reachable path must also be rejected.
    const noinherit = await identityAs(url, NOINHERIT_LOGIN)
    assert.ok(noinherit.error, 'NOINHERIT member of an object-owner role must be rejected')
    assert.match(noinherit.error.message, new RegExp(`privileged roles: ${OWNER_ROLE}`))

    // RI-FIX-04: SET ROLE / RESET ROLE semantics - current_user tracks the active role, session_user the
    // original login; the live check reflects whichever is actually active right now, and reverts cleanly.
    {
      const probe = new PrismaClient({ datasourceUrl: (() => { const u = new URL(url); u.username = INHERIT_LOGIN; u.password = PASSWORD; return u.toString() })() })
      try {
        await probe.$executeRawUnsafe(`SET ROLE "${OWNER_ROLE}"`)
        const [active] = await probe.$queryRawUnsafe(`SELECT current_user AS u, session_user AS s`)
        assert.equal(active.u, OWNER_ROLE)
        assert.equal(active.s, INHERIT_LOGIN)
        await assert.rejects(assertRuntimeDbIdentity(probe, 'fixture:set-role-active'), /owns database objects/)
        await probe.$executeRawUnsafe('RESET ROLE')
        const [reset] = await probe.$queryRawUnsafe(`SELECT current_user AS u, session_user AS s`)
        assert.equal(reset.u, INHERIT_LOGIN)
        assert.equal(reset.s, INHERIT_LOGIN)
        await assert.rejects(assertRuntimeDbIdentity(probe, 'fixture:set-role-reset'), /owns database objects/) // membership itself is still reachable
      } finally {
        await probe.$disconnect()
      }
    }

    console.log(JSON.stringify({ certification: 'runtime-db-identity-role-fixtures', bareOk: true, inheritedRejected: true, noinheritRejected: true, setRoleResetVerified: true }))
  } finally {
    for (const login of [BARE_LOGIN, INHERIT_LOGIN, NOINHERIT_LOGIN]) await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${login}"`)
    await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`)
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${OWNER_ROLE}"`)
    await owner.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof assert.AssertionError ? error.message : `Runtime DB identity certification failed: ${error.message ?? error}`)
  process.exitCode = 1
})
