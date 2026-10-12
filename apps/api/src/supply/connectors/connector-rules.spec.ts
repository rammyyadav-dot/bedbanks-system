import { parseConnectorCreate, parseConnectorUpdate, parseCredentialPurpose, parseCredentialReference, parseTransportMetadata } from './connector-rules'

const code = (fn: () => unknown): string | undefined => { try { fn() } catch (e) { return ((e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code } return undefined }
const good = { supplierId: 'sup_1', name: 'WebBeds XML', type: 'XML_OUT', version: '1.0', transportMetadata: { provider: 'webbeds', endpointHost: 'xml.example-supplier.com', wireFormat: 'xml' } }
const PREFIX = 'fbeds-prod/connectors/'
const SCOPE = { tenantId: 'tenant-a', connectorId: 'conn-1' }

describe('connector admin input rules', () => {
  it('accepts a valid create and defaults transport metadata', () => {
    expect(parseConnectorCreate(good)).toMatchObject({ name: 'WebBeds XML', type: 'XML_OUT' })
    expect(parseConnectorCreate({ ...good, transportMetadata: undefined }).transportMetadata).toEqual({})
  })
  it('never accepts status, capabilities or health (activation is privileged)', () => {
    for (const k of ['status', 'capabilities', 'healthState']) expect(code(() => parseConnectorCreate({ ...good, [k]: 'ACTIVE' }))).toBe('CONNECTOR_STATUS_PRIVILEGED')
    expect(code(() => parseConnectorUpdate({ status: 'ACTIVE' }))).toBe('CONNECTOR_STATUS_PRIVILEGED')
  })
  it('refuses unknown fields, a tenantId in the body, bad types and empty updates', () => {
    expect(code(() => parseConnectorCreate({ ...good, tenantId: 'other' }))).toBe('CONNECTOR_FIELD_UNKNOWN')
    expect(code(() => parseConnectorCreate({ ...good, type: 'SOAP' }))).toBe('CONNECTOR_FIELD_INVALID')
    expect(code(() => parseConnectorCreate({ ...good, name: '<script>' }))).toBe('CONNECTOR_FIELD_INVALID')
    expect(code(() => parseConnectorCreate(null))).toBe('CONNECTOR_BODY_INVALID')
    expect(code(() => parseConnectorUpdate({}))).toBe('CONNECTOR_BODY_INVALID')
  })
  it('transport metadata cannot carry secrets, URLs or unknown keys', () => {
    for (const key of ['password', 'apiKey', 'api_key', 'authToken', 'clientSecret', 'Authorization', 'privateKey', 'credentials']) expect(code(() => parseTransportMetadata({ [key]: 'x' }))).toBe('CONNECTOR_SECRET_IN_METADATA')
    for (const host of ['https://xml.example.com/path', 'user@xml.example.com', 'localhost', 'XML.EXAMPLE.COM', '10.0.0.1', 'a.b/c']) expect(code(() => parseTransportMetadata({ endpointHost: host }))).toBe('CONNECTOR_FIELD_INVALID')
    expect(code(() => parseTransportMetadata({ somethingElse: 'x' }))).toBe('CONNECTOR_TRANSPORT_INVALID')
    expect(code(() => parseTransportMetadata({ wireFormat: 'json' }))).toBe('CONNECTOR_FIELD_INVALID')
    expect(code(() => parseTransportMetadata({ provider: 5 }))).toBe('CONNECTOR_TRANSPORT_INVALID')
    expect(code(() => parseTransportMetadata([]))).toBe('CONNECTOR_TRANSPORT_INVALID')
  })
  it('credential reference must be this connector\'s own secret, for this purpose', () => {
    const ref = `aws-sm:${PREFIX}tenant-a/conn-1/api`
    expect(parseCredentialReference({ secretRef: ref }, PREFIX, SCOPE, 'api')).toBe(ref)
    expect(code(() => parseCredentialReference({ secretRef: ref }, undefined, SCOPE, 'api'))).toBe('CONNECTOR_SECRETS_UNCONFIGURED')
    expect(code(() => parseCredentialReference({ secretRef: `aws-sm:${PREFIX}tenant-b/conn-1/api` }, PREFIX, SCOPE, 'api'))).toBe('CONNECTOR_SECRET_SCOPE')
    expect(code(() => parseCredentialReference({ secretRef: 'aws-sm:fbeds-prod/api/DATABASE_URL' }, PREFIX, SCOPE, 'api'))).toBe('CONNECTOR_SECRET_REFERENCE_INVALID')
    expect(code(() => parseCredentialReference({ secretRef: 'hunter2-plaintext-password' }, PREFIX, SCOPE, 'api'))).toBe('CONNECTOR_SECRET_REFERENCE_INVALID')
    expect(code(() => parseCredentialReference({ secretRef: ref }, PREFIX, SCOPE, 'content'))).toBe('CONNECTOR_SECRET_PURPOSE')
    expect(code(() => parseCredentialReference({ secretRef: ref, extra: 1 }, PREFIX, SCOPE, 'api'))).toBe('CONNECTOR_FIELD_UNKNOWN')
    expect(parseCredentialPurpose('api')).toBe('api')
    expect(code(() => parseCredentialPurpose('API Key'))).toBe('CONNECTOR_FIELD_INVALID')
  })
})
