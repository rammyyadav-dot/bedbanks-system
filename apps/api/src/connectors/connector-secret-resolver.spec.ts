import { ResourceNotFoundException } from '@aws-sdk/client-secrets-manager'
import { AwsSecretsManagerStore, ConnectorSecretResolver, SecretResolutionError, scopedSecretName, type SecretStore } from './connector-secret-resolver'

const PREFIX = 'fbeds-test/connectors'
const scope = { tenantId: 'ten_a', connectorId: 'con_1' }
const ref = (suffix = 'credentials', s = scope) => `aws-sm:${PREFIX}/${s.tenantId}/${s.connectorId}/${suffix}`
const SECRET = JSON.stringify({ user: 'u1', password: 'TOP-SECRET-VALUE-123' })

const store = (values: Record<string, string | Error | null>): SecretStore & { calls: string[] } => {
  const calls: string[] = []
  return { calls, getSecretString: async (name) => { calls.push(name); const v = values[name]; if (v instanceof Error) throw v; return v ?? null } }
}
const code = async (p: Promise<unknown>) => { try { await p; return 'no error' } catch (e) { return e instanceof SecretResolutionError ? e.code : `other:${(e as Error).message}` } }

describe('connector secret resolver (F3)', () => {
  it('resolves a reference under this tenant and connector to a frozen object of strings', async () => {
    const s = store({ [`${PREFIX}/ten_a/con_1/credentials`]: SECRET })
    const r = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX }, s)
    const value = await r.resolve(ref(), scope)
    expect(value).toEqual({ user: 'u1', password: 'TOP-SECRET-VALUE-123' })
    expect(Object.isFrozen(value)).toBe(true)
    expect(s.calls).toEqual([`${PREFIX}/ten_a/con_1/credentials`])
  })

  it('is unconfigured, and resolves nothing, without a prefix', async () => {
    const s = store({})
    const r = new ConnectorSecretResolver({}, s)
    expect(r.configured()).toBe(false)
    expect(await code(r.resolve(ref(), scope))).toBe('not_configured')
    expect(s.calls).toEqual([])
  })

  it('refuses, before any store call, another tenant, another connector, platform secrets, ARNs and traversal', async () => {
    const s = store({})
    const r = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX }, s)
    expect(await code(r.resolve(ref('credentials', { tenantId: 'ten_b', connectorId: 'con_1' }), scope))).toBe('out_of_scope')
    expect(await code(r.resolve(ref('credentials', { tenantId: 'ten_a', connectorId: 'con_2' }), scope))).toBe('out_of_scope')
    expect(await code(r.resolve('aws-sm:fbeds-prod/api/DATABASE_URL', scope))).toBe('out_of_scope')
    expect(await code(r.resolve(`aws-sm:${PREFIX}/ten_a/con_1/`, scope))).toBe('invalid_reference')
    expect(await code(r.resolve(`aws-sm:${PREFIX}/ten_a/con_1/../con_2/x`, scope))).toBe('invalid_reference')
    expect(await code(r.resolve(`aws-sm:${PREFIX}/ten_a/con_1//x`, scope))).toBe('invalid_reference')
    expect(await code(r.resolve(`aws-sm:${PREFIX}/ten_a/con_1/x/`, scope))).toBe('invalid_reference')
    expect(await code(r.resolve('aws-sm:arn:aws:secretsmanager:eu-west-1:111122223333:secret:x', scope))).toBe('invalid_reference')
    expect(await code(r.resolve('arn:aws:secretsmanager:eu-west-1:111122223333:secret:x', scope))).toBe('invalid_reference')
    expect(await code(r.resolve(`aws-sm:${PREFIX}/ten_a/con_1/a b`, scope))).toBe('invalid_reference')
    expect(await code(r.resolve(ref(), { tenantId: 'ten_a/../x', connectorId: 'con_1' }))).toBe('invalid_reference')
    expect(s.calls).toEqual([])
  })

  it('classifies a missing secret, a store failure and malformed material by code, and carries neither reference nor value', async () => {
    const name = `${PREFIX}/ten_a/con_1/credentials`
    const cases: Array<[string | Error | null, string]> = [[null, 'not_found'], [new Error(`AccessDenied ${name} ${SECRET}`), 'unavailable'], ['not json', 'malformed'], ['[]', 'malformed'], ['{}', 'malformed'], ['null', 'malformed'], ['{"a":1}', 'malformed'], ['{"a":""}', 'malformed'], ['{"bad key":"x"}', 'malformed'], [JSON.stringify({ a: 'x'.repeat(2049) }), 'malformed'], [`{"a":"${'x'.repeat(9000)}"}`, 'malformed'], [JSON.stringify(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))), 'malformed']]
    for (const [value, expected] of cases) {
      const r = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX }, store({ [name]: value }))
      const err = await r.resolve(ref(), scope).catch((e: Error) => e)
      expect(err).toBeInstanceOf(SecretResolutionError)
      expect((err as SecretResolutionError).code).toBe(expected)
      expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack?.split('\n')[0] })).not.toContain('TOP-SECRET')
      expect((err as Error).message).not.toContain(name)
    }
  })

  it('caches successes for the configured time, never caches failures, and bounds the cache', async () => {
    let now = 1_000
    const name = `${PREFIX}/ten_a/con_1/credentials`
    const values: Record<string, string | null> = { [name]: SECRET }
    const s = store(values)
    const r = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX, CONNECTOR_SECRET_CACHE_MS: '1000' }, s, () => now)
    await r.resolve(ref(), scope); await r.resolve(ref(), scope)
    expect(s.calls).toHaveLength(1)
    now += 1001
    await r.resolve(ref(), scope)
    expect(s.calls).toHaveLength(2)
    // A failure is not cached: when the secret appears the next call succeeds.
    const missing = ref('later')
    const lateName = `${PREFIX}/ten_a/con_1/later`
    expect(await code(r.resolve(missing, scope))).toBe('not_found')
    values[lateName] = SECRET
    expect(await code(r.resolve(missing, scope))).toBe('no error')
    // Caching can be turned off.
    const off = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX, CONNECTOR_SECRET_CACHE_MS: '0' }, s, () => now)
    const before = s.calls.length
    await off.resolve(ref(), scope); await off.resolve(ref(), scope)
    expect(s.calls.length - before).toBe(2)
  })

  it('check() reports a code without returning the material', async () => {
    const r = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX }, store({ [`${PREFIX}/ten_a/con_1/credentials`]: SECRET }))
    expect(await r.check(ref(), scope)).toEqual({ ok: true })
    expect(await r.check(ref('missing'), scope)).toEqual({ ok: false, reason: 'not_found' })
    expect(await r.check('aws-sm:other/x', scope)).toEqual({ ok: false, reason: 'out_of_scope' })
  })

  it('adapts to the transport port, with the profile validating its own secret shape', async () => {
    const r = new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX }, store({ [`${PREFIX}/ten_a/con_1/credentials`]: SECRET }))
    const resolve = r.asTransportResolver((raw) => ({ user: raw.user, password: raw.password }))
    expect(await resolve(ref(), { tenantId: 'ten_a', supplierId: 'sup', connectorId: 'con_1' })).toEqual({ user: 'u1', password: 'TOP-SECRET-VALUE-123' })
    await expect(resolve(ref(), { tenantId: 'ten_b', supplierId: 'sup', connectorId: 'con_1' })).rejects.toBeInstanceOf(SecretResolutionError)
  })

  it('rejects a malformed prefix or cache setting at startup, and scopedSecretName applies the same rule with no I/O', () => {
    for (const prefix of ['x', 'Upper/Case', 'trailing/', '/leading', 'a//b', 'has space']) expect(() => new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: prefix }, store({}))).toThrow(/CONNECTOR_SECRETS_PREFIX/)
    for (const ms of ['-1', '300001', '1.5', 'abc']) expect(() => new ConnectorSecretResolver({ CONNECTOR_SECRETS_PREFIX: PREFIX, CONNECTOR_SECRET_CACHE_MS: ms }, store({}))).toThrow(/CONNECTOR_SECRET_CACHE_MS/)
    expect(scopedSecretName(ref(), scope, PREFIX)).toBe(`${PREFIX}/ten_a/con_1/credentials`)
    expect(() => scopedSecretName(ref(), scope, undefined)).toThrow(SecretResolutionError)
  })

  it('the AWS store returns the string, maps a missing secret to null and rethrows anything else', async () => {
    const send = jest.fn()
    const aws = new AwsSecretsManagerStore({ send } as never)
    send.mockResolvedValueOnce({ SecretString: SECRET }); expect(await aws.getSecretString('n')).toBe(SECRET)
    send.mockResolvedValueOnce({ SecretBinary: new Uint8Array([1]) }); expect(await aws.getSecretString('n')).toBeNull()
    send.mockRejectedValueOnce(new ResourceNotFoundException({ message: 'x', $metadata: {} })); expect(await aws.getSecretString('n')).toBeNull()
    send.mockRejectedValueOnce(new Error('AccessDenied')); await expect(aws.getSecretString('n')).rejects.toThrow('AccessDenied')
    expect(send.mock.calls[0][0].input).toEqual({ SecretId: 'n' })
  })
})
