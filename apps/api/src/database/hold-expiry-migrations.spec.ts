import { assessMigrations } from './hold-expiry-migrations'

const done = (name: string) => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null })
const target = '202609280001_hold_expiry_system_audit_policy'

describe('assessMigrations', () => {
  it('is safe when only the expected migration is pending', () => {
    const result = assessMigrations(['a', 'b', target], [done('a'), done('b')], [target])
    expect(result).toMatchObject({ pending: [target], safeToApply: true })
  })

  it('is safe when nothing is pending (already applied)', () => {
    expect(assessMigrations(['a', target], [done('a'), done(target)], [target])).toMatchObject({ pending: [], safeToApply: true })
  })

  it('blocks when other migrations are pending', () => {
    const result = assessMigrations(['a', 'b', target], [done('a')], [target])
    expect(result).toMatchObject({ unexpectedPending: ['b'], safeToApply: false })
  })

  it('blocks on failed or rolled-back migrations', () => {
    const failed = { migration_name: 'b', finished_at: null, rolled_back_at: null }
    expect(assessMigrations(['a', 'b', target], [done('a'), failed], [target]).safeToApply).toBe(false)
    const rolledBack = { migration_name: 'b', finished_at: new Date(), rolled_back_at: new Date() }
    expect(assessMigrations(['a', 'b', target], [done('a'), rolledBack], [target]).safeToApply).toBe(false)
  })

  it('blocks when the database has migrations this repo does not know', () => {
    const result = assessMigrations(['a', target], [done('a'), done('ghost')], [target])
    expect(result).toMatchObject({ unknownApplied: ['ghost'], safeToApply: false })
  })
})
