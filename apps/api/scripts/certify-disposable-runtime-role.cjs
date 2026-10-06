// Engineering-only certification on the PostgreSQL service declared in CI.
// Owner connection provisions fixtures/roles; all privilege probes use a new
// connection authenticated as the strict login. Never log connection strings.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { appendFileSync } = require('node:fs')
const { PrismaClient } = require('@prisma/client')
const { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } = require('../src/database/api-runtime-role')
const { RUNTIME_ROLE_GRANTS } = require('../src/database/runtime-role-contract')
const { rolloutVerify } = require('../src/database/strict-role-rollout')

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable GitHub Actions service required')
  assert.equal(process.env.NODE_ENV, 'test', 'Test environment required')
  const target = new URL(process.env.DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Loopback database required')
  assert.equal(target.pathname, '/fbeds_ci', 'Disposable CI database required')
  const owner = new PrismaClient({ datasourceUrl: target.toString() })
  let runtime
  try {
    const [server] = await owner.$queryRawUnsafe('SELECT current_database() AS database, current_setting(\'server_version\') AS version')
    assert.equal(server.database, 'fbeds_ci')
    assert.match(server.version, /^16\./, 'PostgreSQL 16 required')
    if (process.argv.includes('--rotate-owner')) {
      assert.equal(target.username, 'postgres', 'Disposable service bootstrap owner required')
      assert.ok(process.env.GITHUB_ENV, 'Actions environment output required')
      const password = randomBytes(32).toString('hex')
      // Hex-only generated value; never interpolate user-provided credentials.
      await owner.$executeRawUnsafe(`ALTER ROLE postgres PASSWORD '${password}'`)
      target.password = password
      console.log(`::add-mask::${password}`)
      appendFileSync(process.env.GITHUB_ENV, `DATABASE_URL=${target.toString()}\nMAPPING_DATABASE_URL=${target.toString()}\n`)
      console.log('Disposable service owner credential rotated; later steps receive the new credential without printing it.')
      return
    }
    const extensions = await owner.$queryRawUnsafe("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname")
    assert.deepEqual(extensions.map((r) => r.extname), ['pg_trgm', 'vector'])
    const password = randomBytes(32).toString('hex')
    await provisionApiRuntimeRole(owner, { password })
    target.username = API_RUNTIME_LOGIN_ROLE
    target.password = password
    runtime = new PrismaClient({ datasourceUrl: target.toString() })
    const [identity] = await runtime.$queryRawUnsafe('SELECT current_user AS principal, session_user AS session_principal')
    assert.equal(identity.principal, API_RUNTIME_LOGIN_ROLE)
    assert.equal(identity.session_principal, API_RUNTIME_LOGIN_ROLE)
    const contract = await verifyApiRuntimeRole(runtime)
    assert.deepEqual(contract, { ok: true, failures: [] })
    const probes = await rolloutVerify(runtime)
    assert.equal(probes.ok, true, 'Strict runtime privilege probes must pass')
    const security = await runtime.$queryRawUnsafe("SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")
    const required = RUNTIME_ROLE_GRANTS.filter((g) => g.rls === 'forced-tenant')
    for (const grant of required) {
      const row = security.find((r) => r.name === grant.table)
      assert.ok(row?.enabled && row.forced, `Forced RLS required: ${grant.table}`)
    }
    console.log(JSON.stringify({ certification: 'disposable-engineering-only', host: target.hostname, port: target.port || '5432', database: server.database, postgres: server.version, node: process.version, ...identity, contract: 'PASS', privilegeProbes: probes.probes.length, forcedRlsTables: required.length, extensions: extensions.map((r) => r.extname) }))
  } finally {
    await runtime?.$disconnect()
    await owner.$disconnect()
  }
}
main().catch((error) => {
  // Assertion diagnostics contain only the explicit safe checks above.
  // Never print a Prisma error: a provisioning query could contain a secret.
  console.error(error instanceof assert.AssertionError ? error.message : 'Disposable strict-role certification failed (database operation); no credentials are printed.')
  process.exitCode = 1
})
