import { assessMigrations } from './hold-expiry-migrations'

const done = (name: string) => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null })
const rolledBack = (name: string) => ({ migration_name: name, finished_at: null, rolled_back_at: new Date() })
const failedRow = (name: string) => ({ migration_name: name, finished_at: null, rolled_back_at: null })
const target = '202609280001_hold_expiry_system_audit_policy'

describe('assessMigrations', () => {
  it('is safe when only the expected migration is pending', () => {
    expect(assessMigrations(['a', 'b', target], [done('a'), done('b')], [target])).toMatchObject({ pending: [target], safeToApply: true })
  })

  it('is safe when nothing is pending (already applied)', () => {
    expect(assessMigrations(['a', target], [done('a'), done(target)], [target])).toMatchObject({ pending: [], safeToApply: true })
  })

  it('blocks when other migrations are pending', () => {
    expect(assessMigrations(['a', 'b', target], [done('a')], [target])).toMatchObject({ unexpectedPending: ['b'], safeToApply: false })
  })

  it('ignores resolved history: a rolled-back row that was later re-applied is not a blocker', () => {
    const rows = [done('a'), rolledBack('b'), done('b'), rolledBack('c'), rolledBack('c'), done('c')]
    expect(assessMigrations(['a', 'b', 'c', target], rows, [target])).toMatchObject({ failed: [], rolledBack: ['b', 'c'], pending: [target], safeToApply: true })
  })

  it('treats a rolled-back migration with no finished row as pending, not failed', () => {
    const result = assessMigrations(['a', 'b'], [done('a'), rolledBack('b')], ['b'])
    expect(result).toMatchObject({ failed: [], pending: ['b'], safeToApply: true })
  })

  it('blocks on an unresolved failure (started, never finished, not rolled back)', () => {
    const result = assessMigrations(['a', 'b', target], [done('a'), failedRow('b')], [target])
    expect(result).toMatchObject({ failed: ['b'], safeToApply: false })
  })

  it('blocks when the database has migrations this repo does not know', () => {
    expect(assessMigrations(['a', target], [done('a'), done('ghost')], [target])).toMatchObject({ unknownApplied: ['ghost'], safeToApply: false })
  })

  it('catch-up accepts any pending migrations but still blocks failures and unknown migrations', () => {
    expect(assessMigrations(['a', 'b', 'c', target], [done('a')], [target], { allowCatchUp: true })).toMatchObject({ pending: [target, 'b', 'c'], safeToApply: true })
    expect(assessMigrations(['a', 'b'], [done('a'), failedRow('b')], [], { allowCatchUp: true }).safeToApply).toBe(false)
    expect(assessMigrations(['a', 'b'], [done('a'), done('ghost')], [], { allowCatchUp: true }).safeToApply).toBe(false)
  })
})
