import { AwsConnectorSecretResolver, ConnectorSecretError, connectorSecretResolverFromEnvironment, UnconfiguredConnectorSecretResolver } from './connector-secret-resolver'

const SCOPE = { tenantId: 'tenant-a', supplierId: 'sup-1', connectorId: 'conn-1' }
const PREFIX = 'fbeds-prod/connectors/'
const REF = `aws-sm:${PREFIX}tenant-a/conn-1/api`
function resolver(send: jest.Mock, extra: { now?: () => number } = {}) {
  return new AwsConnectorSecretResolver({ send } as never, { prefix: PREFIX, ...extra }, (id) => ({ id }) as never)
}
const secret = (value: unknown) => ({ SecretString: typeof value === 'string' ? value : JSON.stringify(value) })
const failsWith = async (promise: Promise<unknown>, c: string, extra?: (e: Error) => boolean): Promise<void> => {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(ConnectorSecretError)
  expect((error as ConnectorSecretError).code).toBe(c)
  if (extra) expect(extra(error as Error)).toBe(true)
}

describe('connector secret resolver', () => {
  it('resolves a scoped reference and caches briefly', async () => {
    const send = jest.fn().mockResolvedValue(secret({ username: 'u', password: 'p' }))
    let now = 0
    const r = resolver(send, { now: () => now })
    expect(await r.resolve(REF, SCOPE)).toEqual({ username: 'u', password: 'p' })
    await r.resolve(REF, SCOPE)
    expect(send).toHaveBeenCalledTimes(1)
    now = 61_000
    await r.resolve(REF, SCOPE)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toEqual({ id: `${PREFIX}tenant-a/conn-1/api` })
  })
  it('refuses references outside the prefix, malformed, or for another tenant/connector WITHOUT calling AWS', async () => {
    const send = jest.fn()
    const r = resolver(send)
    for (const ref of ['aws-sm:fbeds-prod/api/DATABASE_URL', 'aws-sm:other/connectors/tenant-a/conn-1/api', 'env:PATH', `aws-sm:${PREFIX}tenant-a/conn-1`, `aws-sm:${PREFIX}tenant-a/conn-1/api/extra`, `aws-sm:${PREFIX}../x/y/z`, 'arn:aws:secretsmanager:eu-west-1:1:secret:x', '']) {
      await failsWith(r.resolve(ref, SCOPE), 'invalid_reference')
    }
    await failsWith(r.resolve(`aws-sm:${PREFIX}tenant-b/conn-1/api`, SCOPE), 'scope_mismatch')
    await failsWith(r.resolve(`aws-sm:${PREFIX}tenant-a/conn-2/api`, SCOPE), 'scope_mismatch')
    expect(send).not.toHaveBeenCalled()
  })
  it('classifies AWS failures and bad material without leaking either', async () => {
    const leaky = new Error('AccessDenied for arn:...:TOP-SECRET')
    await failsWith(resolver(jest.fn().mockRejectedValue(leaky)).resolve(REF, SCOPE), 'unavailable', (e) => !e.message.includes('TOP-SECRET'))
    for (const bad of ['not json', '[]', '{}', '{"a":1}', '{"a":""}', '{"bad key":"x"}', undefined]) {
      await failsWith(resolver(jest.fn().mockResolvedValue({ SecretString: bad })).resolve(REF, SCOPE), 'invalid_secret')
    }
  })
  it('is unconfigured by default and never falls back', async () => {
    await failsWith(new UnconfiguredConnectorSecretResolver().resolve(), 'unconfigured')
    expect(await connectorSecretResolverFromEnvironment({})).toBeInstanceOf(UnconfiguredConnectorSecretResolver)
    expect(await connectorSecretResolverFromEnvironment({ CONNECTOR_SECRET_PREFIX: '  ' })).toBeInstanceOf(UnconfiguredConnectorSecretResolver)
  })
  it('rejects an unsafe configured prefix', () => {
    expect(() => new AwsConnectorSecretResolver({ send: jest.fn() } as never, { prefix: 'fbeds-prod/connectors' }, () => ({}) as never)).toThrow(ConnectorSecretError)
    expect(() => new AwsConnectorSecretResolver({ send: jest.fn() } as never, { prefix: '/' }, () => ({}) as never)).toThrow(ConnectorSecretError)
  })
})
