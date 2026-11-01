import { assertPreviewFixtureTarget, PREVIEW_FIXTURE_DATABASE } from './preview-fixture-target'

describe('assertPreviewFixtureTarget', () => {
  const local = `postgresql://owner:secret@127.0.0.1:5432/${PREVIEW_FIXTURE_DATABASE}`

  it('accepts the local disposable database', () => {
    expect(assertPreviewFixtureTarget(local, [])).toEqual({ host: '127.0.0.1', database: PREVIEW_FIXTURE_DATABASE })
  })

  it('refuses persistent and other disposable databases', () => {
    for (const name of ['fbeds_dev', 'fbeds_golden', 'fbeds_supplier_xt', 'postgres', 'neondb']) {
      expect(() => assertPreviewFixtureTarget(`postgresql://owner:secret@127.0.0.1:5432/${name}`, [])).toThrow(/refuse database/)
    }
  })

  it('refuses a remote target until the owner confirms the disposable name', () => {
    const remote = `postgresql://owner:secret@ep.example.net:5432/${PREVIEW_FIXTURE_DATABASE}`
    expect(() => assertPreviewFixtureTarget(remote, [])).toThrow(/Remote target/)
    expect(assertPreviewFixtureTarget(remote, ['--allow-remote', `--confirm-database=${PREVIEW_FIXTURE_DATABASE}`]).database).toBe(PREVIEW_FIXTURE_DATABASE)
  })

  it('refuses a remote confirmation of a different database', () => {
    const remote = 'postgresql://owner:secret@ep.example.net:5432/fbeds_dev'
    expect(() => assertPreviewFixtureTarget(remote, ['--allow-remote', '--confirm-database=fbeds_dev'])).toThrow(/refuse database/)
  })
})
