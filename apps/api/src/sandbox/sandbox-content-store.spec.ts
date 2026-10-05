import { sandboxStagingGrantSql, stagingPagePayload, stagingParameterHash, SandboxStagingError } from './sandbox-content-store'

describe('quarantined sandbox staging contract', () => {
  it('binds parameters deterministically and rejects impossible dates', () => {
    expect(stagingParameterHash(null)).toBe(stagingParameterHash(null))
    expect(stagingParameterHash('2026-10-05')).not.toBe(stagingParameterHash(null))
    expect(() => stagingParameterHash('2026-02-30')).toThrow(SandboxStagingError)
  })
  it('hashes immutable content independently of JSON object ordering', () => {
    expect(stagingPagePayload([{ code: 1, name: 'Hotel' }]).payloadHash)
      .toBe(stagingPagePayload([{ name: 'Hotel', code: 1 }]).payloadHash)
    expect(stagingPagePayload([{ code: 2 }]).payloadHash).not.toBe(stagingPagePayload([{ code: 1 }]).payloadHash)
  })
  it.each(['secret', 'apiKey', 'rateKey', 'authorization', 'password'])('rejects credential or booking material: %s', key => {
    expect(() => stagingPagePayload([{ code: 1, nested: { [key]: 'sensitive' } }])).toThrow(SandboxStagingError)
  })
  it('rejects duplicate, oversized and invalid supplier identities', () => {
    expect(() => stagingPagePayload([{ code: 1 }, { code: 1 }])).toThrow(SandboxStagingError)
    expect(() => stagingPagePayload([{ code: 0 }])).toThrow(SandboxStagingError)
    expect(() => stagingPagePayload(Array.from({ length: 101 }, (_, code) => ({ code: code + 1 })))).toThrow(SandboxStagingError)
  })
  it('keeps authoring grants outside canonical content and stock tables', () => {
    const sql = sandboxStagingGrantSql('sandbox_test_role').join('\n')
    expect(sql).not.toMatch(/GRANT DELETE|GRANT UPDATE ON|InventoryPool|InventoryHold|SupplierMutation|Hotel"|fbeds_api/)
    expect(sql).toContain('GRANT SELECT, INSERT ON "SandboxContentPage"')
    expect(sql).not.toMatch(/GRANT UPDATE[^\n]*SandboxContentPage/)
    expect(() => sandboxStagingGrantSql('invalid;role')).toThrow()
  })
})
