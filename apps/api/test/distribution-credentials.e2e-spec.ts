import { createHash, randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'

/**
 * ADR 0075 amendment 3: partner credentials and their authentication functions, against PostgreSQL, as a restricted login
 * (NOSUPERUSER, NOBYPASSRLS, owns nothing) holding only EXECUTE on the two functions: what step 2 grants the API runtime.
 */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const keyId = () => Array.from(randomBytes(20), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
const HOUR = 3_600_000

describe('distribution credentials and authentication functions (ADR 0075 amendment 3, PostgreSQL)', () => {
  const owner = new PrismaService()
  const suffix = `dist-${Date.now()}-${randomBytes(3).toString('hex')}`
  const loginRole = `fbeds_dist_t${randomBytes(4).toString('hex')}`
  const outsiderRole = `fbeds_dist_o${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  let login: PrismaClient
  let outsider: PrismaClient
  let userId: string
  const tenants: string[] = []

  const loginUrl = (role: string) => {
    const url = new URL(process.env.DATABASE_URL as string)
    url.username = role; url.password = password
    return url.toString()
  }

  async function tenant(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const slug = `${suffix}-${tenants.length}`
    const id = (await owner.tenant.create({ data: { name: slug, slug, status } })).id
    tenants.push(id)
    return id
  }
  async function agency(tenantId: string, status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    return (await owner.agency.create({ data: { tenantId, code: `AG-${randomBytes(3).toString('hex').toUpperCase()}`, name: 'Partner Travel', status, createdById: userId } })).id
  }
  async function client(tenantId: string, agencyId: string, extra: Record<string, unknown> = {}) {
    return (await owner.distributionClient.create({ data: { tenantId, agencyId, name: `client-${randomBytes(3).toString('hex')}`, scopes: ['SEARCH', 'CHECKRATE', 'BOOK'], createdByUserId: userId, ...extra } as never })).id
  }
  async function credential(tenantId: string, clientId: string, extra: Record<string, unknown> = {}) {
    const id = keyId()
    const secret = randomBytes(32).toString('base64url')
    const row = await owner.distributionCredential.create({ data: { tenantId, clientId, kind: 'API_KEY', keyId: id, secretHash: sha256(secret), createdByUserId: userId, ...extra } as never })
    return { id: row.id, keyId: id, secretHash: sha256(secret) }
  }
  async function token(tenantId: string, clientId: string, credentialId: string, extra: Record<string, unknown> = {}) {
    const hash = sha256(randomBytes(32).toString('base64url'))
    const row = await owner.distributionAccessToken.create({ data: { tenantId, clientId, credentialId, tokenHash: hash, scopes: ['SEARCH', 'BOOK'], expiresAt: new Date(Date.now() + 15 * 60_000), ...extra } as never })
    return { id: row.id, hash }
  }
  /** A ready partner: ACTIVE tenant, agency and client, with one OAuth client credential. */
  async function partner() {
    const tenantId = await tenant()
    const agencyId = await agency(tenantId)
    const clientId = await client(tenantId, agencyId)
    const cred = await credential(tenantId, clientId, { kind: 'OAUTH_CLIENT' })
    return { tenantId, agencyId, clientId, cred }
  }

  const authKey = (db: PrismaClient, id: string, hash: string) =>
    db.$queryRawUnsafe<Array<{ tenant_id: string; agency_id: string; client_id: string; credential_id: string; kind: string; scopes: string[] }>>(
      'SELECT "tenant_id", "agency_id", "client_id", "credential_id", "kind"::text AS "kind", "scopes"::text[] AS "scopes" FROM "fbeds_distribution_authenticate_key"($1, $2)', id, hash)
  const authToken = (db: PrismaClient, hash: string) =>
    db.$queryRawUnsafe<Array<{ tenant_id: string; agency_id: string; client_id: string; token_id: string; scopes: string[] }>>(
      'SELECT "tenant_id", "agency_id", "client_id", "token_id", "scopes"::text[] AS "scopes" FROM "fbeds_distribution_authenticate_token"($1)', hash)
  const expectDenied = (promise: Promise<unknown>) => expect(promise).rejects.toThrow(/permission denied/)
  const expectRefused = (promise: Promise<unknown>, message: RegExp) => expect(promise).rejects.toThrow(message)

  beforeAll(async () => {
    for (const role of [loginRole, outsiderRole]) {
      await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'`)
      await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    }
    // Only the login gets the functions; the outsider has nothing, like any role step 2 does not name.
    await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION "fbeds_distribution_authenticate_key"(TEXT, TEXT), "fbeds_distribution_authenticate_token"(TEXT) TO "${loginRole}"`)
    login = new PrismaClient({ datasourceUrl: loginUrl(loginRole) })
    outsider = new PrismaClient({ datasourceUrl: loginUrl(outsiderRole) })
    userId = (await owner.user.create({ data: { email: `${suffix}@example.test` } })).id
  })

  afterAll(async () => {
    await login?.$disconnect()
    await outsider?.$disconnect()
    await owner.$transaction(async (tx) => {
      // Credentials and clients are delete-proof by trigger; replica mode skips triggers for test cleanup only.
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const table of ['distribution_access_tokens', 'distribution_credentials', 'distribution_clients', 'Agency']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = ANY($1::text[])`, tenants)
      }
      await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = ANY($1::text[])', tenants)
    })
    await owner.user.deleteMany({ where: { email: { startsWith: suffix } } })
    for (const role of [loginRole, outsiderRole]) {
      await owner.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "fbeds_distribution_authenticate_key"(TEXT, TEXT), "fbeds_distribution_authenticate_token"(TEXT) FROM "${role}"`)
      await owner.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM "${role}"`)
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)
    }
    await owner.$disconnect()
  })

  describe('API key / client secret lookup', () => {
    it('returns exactly the identity of a valid key: tenant, agency, client, credential, kind and scopes; never a hash', async () => {
      const p = await partner()
      const rows = await authKey(login, p.cred.keyId, p.cred.secretHash)
      expect(rows).toEqual([{ tenant_id: p.tenantId, agency_id: p.agencyId, client_id: p.clientId, credential_id: p.cred.id, kind: 'OAUTH_CLIENT', scopes: ['SEARCH', 'CHECKRATE', 'BOOK'] }])
    })

    it('refuses identically (no row) for a wrong secret, an unknown key and malformed input', async () => {
      const p = await partner()
      for (const [id, hash] of [
        [p.cred.keyId, sha256('wrong secret')],
        [keyId(), p.cred.secretHash],
        [p.cred.keyId.toUpperCase(), p.cred.secretHash],
        [`${p.cred.keyId}' OR '1'='1`, p.cred.secretHash],
        [p.cred.keyId, p.cred.secretHash.toUpperCase()],
        [p.cred.keyId, ''],
      ]) await expect(authKey(login, id, hash)).resolves.toEqual([])
    })

    it('refuses a revoked or expired credential', async () => {
      const p = await partner()
      const revoked = await credential(p.tenantId, p.clientId, { revokedAt: new Date() })
      const expired = await credential(p.tenantId, p.clientId, { createdAt: new Date(Date.now() - 2 * HOUR), expiresAt: new Date(Date.now() - HOUR) })
      const future = await credential(p.tenantId, p.clientId, { expiresAt: new Date(Date.now() + HOUR) })
      await expect(authKey(login, revoked.keyId, revoked.secretHash)).resolves.toEqual([])
      await expect(authKey(login, expired.keyId, expired.secretHash)).resolves.toEqual([])
      await expect(authKey(login, future.keyId, future.secretHash)).resolves.toHaveLength(1)
    })

    it('refuses when the client is suspended or revoked, the agency is suspended or inactive, or the tenant is suspended', async () => {
      const cases: Array<() => Promise<{ keyId: string; secretHash: string }>> = [
        async () => { const t = await tenant(); return credential(t, await client(t, await agency(t), { status: 'SUSPENDED' })) },
        async () => { const t = await tenant(); return credential(t, await client(t, await agency(t), { status: 'REVOKED' })) },
        async () => { const t = await tenant(); return credential(t, await client(t, await agency(t, 'SUSPENDED'))) },
        async () => { const t = await tenant(); return credential(t, await client(t, await agency(t, 'INACTIVE'))) },
        async () => { const t = await tenant('SUSPENDED'); return credential(t, await client(t, await agency(t))) },
      ]
      for (const make of cases) {
        const cred = await make()
        await expect(authKey(login, cred.keyId, cred.secretHash)).resolves.toEqual([])
      }
    })
  })

  describe('access token lookup', () => {
    it('returns the identity and scopes of a valid token', async () => {
      const p = await partner()
      const t = await token(p.tenantId, p.clientId, p.cred.id)
      await expect(authToken(login, t.hash)).resolves.toEqual([{ tenant_id: p.tenantId, agency_id: p.agencyId, client_id: p.clientId, token_id: t.id, scopes: ['SEARCH', 'BOOK'] }])
    })

    it('cuts the token scopes to the client scopes at every lookup, and refuses when nothing is left', async () => {
      const p = await partner()
      const t = await token(p.tenantId, p.clientId, p.cred.id)
      await owner.distributionClient.update({ where: { id: p.clientId }, data: { scopes: ['SEARCH', 'CHECKRATE'] } as never })
      await expect(authToken(login, t.hash)).resolves.toEqual([expect.objectContaining({ scopes: ['SEARCH'] })])
      await owner.distributionClient.update({ where: { id: p.clientId }, data: { scopes: ['CHECKRATE'] } as never })
      await expect(authToken(login, t.hash)).resolves.toEqual([])
    })

    it('refuses an expired or revoked token, and every token of a revoked or API-key credential', async () => {
      const p = await partner()
      const expired = await token(p.tenantId, p.clientId, p.cred.id, { createdAt: new Date(Date.now() - HOUR), expiresAt: new Date(Date.now() - 60_000) })
      const revoked = await token(p.tenantId, p.clientId, p.cred.id, { revokedAt: new Date() })
      await expect(authToken(login, expired.hash)).resolves.toEqual([])
      await expect(authToken(login, revoked.hash)).resolves.toEqual([])

      const minted = await token(p.tenantId, p.clientId, p.cred.id)
      await expect(authToken(login, minted.hash)).resolves.toHaveLength(1)
      await owner.distributionCredential.update({ where: { id: p.cred.id }, data: { revokedAt: new Date() } })
      await expect(authToken(login, minted.hash)).resolves.toEqual([])

      const apiKey = await credential(p.tenantId, p.clientId, { kind: 'API_KEY' })
      const wrongKind = await token(p.tenantId, p.clientId, apiKey.id)
      await expect(authToken(login, wrongKind.hash)).resolves.toEqual([])
    })

    it('refuses a token whose client, agency or tenant is no longer active', async () => {
      const p = await partner()
      const t = await token(p.tenantId, p.clientId, p.cred.id)
      await owner.agency.update({ where: { id: p.agencyId }, data: { status: 'SUSPENDED' } })
      await expect(authToken(login, t.hash)).resolves.toEqual([])
      await owner.agency.update({ where: { id: p.agencyId }, data: { status: 'ACTIVE' } })
      await owner.tenant.update({ where: { id: p.tenantId }, data: { status: 'SUSPENDED' } })
      await expect(authToken(login, t.hash)).resolves.toEqual([])
      await owner.tenant.update({ where: { id: p.tenantId }, data: { status: 'ACTIVE' } })
      await expect(authToken(login, t.hash)).resolves.toHaveLength(1)
    })

    it('refuses malformed token input without error', async () => {
      for (const hash of ['', 'x', sha256('a').toUpperCase(), `${sha256('a')}' OR '1'='1`]) await expect(authToken(login, hash)).resolves.toEqual([])
    })
  })

  describe('privileges and isolation', () => {
    it('the restricted login can authenticate but cannot read or write any credential table', async () => {
      for (const table of ['distribution_clients', 'distribution_credentials', 'distribution_access_tokens']) {
        await expectDenied(login.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`))
        await expectDenied(login.$executeRawUnsafe(`DELETE FROM "${table}"`))
      }
      await expectDenied(login.$queryRawUnsafe('SELECT "secret_hash" FROM "distribution_credentials" LIMIT 1'))
    })

    it('a role without EXECUTE cannot call the functions (not executable by PUBLIC)', async () => {
      await expectDenied(outsider.$queryRawUnsafe('SELECT * FROM "fbeds_distribution_authenticate_key"($1, $2)', keyId(), sha256('x')))
      await expectDenied(outsider.$queryRawUnsafe('SELECT * FROM "fbeds_distribution_authenticate_token"($1)', sha256('x')))
      const [publicExec] = await owner.$queryRawUnsafe<Array<{ key: boolean; token: boolean }>>(
        `SELECT has_function_privilege('public', '"fbeds_distribution_authenticate_key"(text, text)', 'EXECUTE') AS key,
                has_function_privilege('public', '"fbeds_distribution_authenticate_token"(text)', 'EXECUTE') AS token`)
      expect(publicExec).toEqual({ key: false, token: false })
    })

    it('forced RLS: a role granted SELECT sees only its own tenant, and nothing without a tenant', async () => {
      const a = await partner()
      const b = await partner()
      await owner.$executeRawUnsafe(`GRANT SELECT ("id", "tenant_id") ON "distribution_clients" TO "${outsiderRole}"`)
      try {
        const visible = (tenantId: string | null) => outsider.$transaction(async (tx) => {
          if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', $1, true)`, tenantId)
          return tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "distribution_clients" WHERE "id" = ANY($1::text[])', [a.clientId, b.clientId])
        })
        await expect(visible(a.tenantId)).resolves.toEqual([{ id: a.clientId }])
        await expect(visible(b.tenantId)).resolves.toEqual([{ id: b.clientId }])
        await expect(visible(null)).resolves.toEqual([])
      } finally {
        await owner.$executeRawUnsafe(`REVOKE SELECT ("id", "tenant_id") ON "distribution_clients" FROM "${outsiderRole}"`)
      }
    })

    it('the authentication functions are SECURITY DEFINER with a pinned search_path', async () => {
      const rows = await owner.$queryRawUnsafe<Array<{ name: string; definer: boolean; pinned: boolean }>>(
        `SELECT p.proname AS name, p.prosecdef AS definer, coalesce(EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), false) AS pinned
           FROM pg_proc p WHERE p.proname IN ('fbeds_distribution_authenticate_key', 'fbeds_distribution_authenticate_token') ORDER BY 1`)
      expect(rows).toEqual([
        { name: 'fbeds_distribution_authenticate_key', definer: true, pinned: true },
        { name: 'fbeds_distribution_authenticate_token', definer: true, pinned: true },
      ])
    })
  })

  describe('integrity (every role, including the owner)', () => {
    it('a credential key, hash, owner and expiry never change; revocation is one-way; credentials are never deleted', async () => {
      const p = await partner()
      const id = p.cred.id
      await expectRefused(owner.distributionCredential.update({ where: { id }, data: { secretHash: sha256('replaced') } }), /immutable/)
      await expectRefused(owner.distributionCredential.update({ where: { id }, data: { keyId: keyId() } }), /immutable/)
      await expectRefused(owner.distributionCredential.update({ where: { id }, data: { expiresAt: new Date(Date.now() + HOUR) } }), /immutable/)
      await owner.distributionCredential.update({ where: { id }, data: { lastUsedAt: new Date() } })
      await owner.distributionCredential.update({ where: { id }, data: { revokedAt: new Date() } })
      await expectRefused(owner.distributionCredential.update({ where: { id }, data: { revokedAt: null } }), /permanent/)
      await expectRefused(owner.distributionCredential.delete({ where: { id } }), /never deleted/)
    })

    it('a client keeps its tenant and agency, never leaves REVOKED and is never deleted', async () => {
      const p = await partner()
      const otherAgency = await agency(p.tenantId)
      await expectRefused(owner.distributionClient.update({ where: { id: p.clientId }, data: { agencyId: otherAgency } as never }), /immutable/)
      await owner.distributionClient.update({ where: { id: p.clientId }, data: { status: 'SUSPENDED' } })
      await owner.distributionClient.update({ where: { id: p.clientId }, data: { status: 'REVOKED' } })
      await expectRefused(owner.distributionClient.update({ where: { id: p.clientId }, data: { status: 'ACTIVE' } }), /stays revoked/)
      await expectRefused(owner.distributionClient.delete({ where: { id: p.clientId } }), /never deleted/)
    })

    it('value rules: key and hash formats, scopes, limits and CIDR allowlist', async () => {
      const p = await partner()
      await expectRefused(credential(p.tenantId, p.clientId, { keyId: 'SHORT' }), /check constraint|violates/)
      await expectRefused(credential(p.tenantId, p.clientId, { secretHash: 'not-a-hash' }), /check constraint|violates/)
      await expectRefused(client(p.tenantId, p.agencyId, { scopes: [] }), /check constraint|violates/)
      await expectRefused(client(p.tenantId, p.agencyId, { bookPerMinute: 0 }), /check constraint|violates/)
      await expectRefused(client(p.tenantId, p.agencyId, { ipAllowlist: ['not-an-ip'] }), /cidr|invalid/i)
      await expect(client(p.tenantId, p.agencyId, { ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'] })).resolves.toEqual(expect.any(String))
    })

    it('a token lives at most an hour, is immutable except revocation, and belongs to a credential of its own client', async () => {
      const p = await partner()
      const other = await client(p.tenantId, p.agencyId)
      await expectRefused(token(p.tenantId, p.clientId, p.cred.id, { expiresAt: new Date(Date.now() + 2 * HOUR) }), /check constraint|violates/)
      await expectRefused(token(p.tenantId, other, p.cred.id), /foreign key/i)
      const t = await token(p.tenantId, p.clientId, p.cred.id)
      await expectRefused(owner.distributionAccessToken.update({ where: { id: t.id }, data: { scopes: ['SEARCH', 'BOOK', 'CANCEL'] } as never }), /immutable/)
      await owner.distributionAccessToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } })
      await expectRefused(owner.distributionAccessToken.update({ where: { id: t.id }, data: { revokedAt: null } }), /permanent/)
    })

    it('a token is deletable only a day after it expired', async () => {
      const p = await partner()
      const live = await token(p.tenantId, p.clientId, p.cred.id)
      const old = await token(p.tenantId, p.clientId, p.cred.id, { createdAt: new Date(Date.now() - 3 * 24 * HOUR), expiresAt: new Date(Date.now() - 3 * 24 * HOUR + HOUR) })
      await expectRefused(owner.distributionAccessToken.delete({ where: { id: live.id } }), /a day after it expired/)
      await expect(owner.distributionAccessToken.delete({ where: { id: old.id } })).resolves.toEqual(expect.objectContaining({ id: old.id }))
    })
  })
})
