import { PRIVILEGE_PROBES, ROLLOUT_MIGRATION, classifyMigrations, isPooledHost } from './strict-role-rollout'
import { readdirSync } from 'fs'
import { join } from 'path'

const done = (n: string) => ({ migration_name: n, finished_at: '2026-10-01', rolled_back_at: null })

describe('strict-role rollout checks (pure)', () => {
  it('classifies applied, pending, unfinished, unknown and rolled-back migrations the way Prisma does', () => {
    const s = classifyMigrations(['a', 'b', 'c'], [done('a'), { migration_name: 'b', finished_at: null, rolled_back_at: null }, { migration_name: 'x', finished_at: null, rolled_back_at: '2026-10-02' }, done('z')])
    expect(s).toEqual({ applied: ['a'], pending: ['b', 'c'], unfinished: ['b'], unknown: ['z'], rolledBack: ['x'] })
  })
  it('a migration retried to completion is not unfinished', () => {
    const s = classifyMigrations(['a'], [{ migration_name: 'a', finished_at: null, rolled_back_at: null }, done('a')])
    expect(s).toMatchObject({ applied: ['a'], pending: [], unfinished: [] })
  })
  it('detects pooled endpoints', () => {
    expect(isPooledHost('ep-x-pooler.eu-west-2.aws.neon.tech')).toBe(true)
    expect(isPooledHost('ep-x.eu-west-2.aws.neon.tech')).toBe(false)
    expect(isPooledHost('localhost')).toBe(false)
  })
  it('the rollout migration exists in the repository', () => {
    expect(readdirSync(join(__dirname, '..', '..', 'prisma', 'migrations'))).toContain(ROLLOUT_MIGRATION)
  })
  it('every probe is a no-row statement, so a probe can never read or write data', () => {
    for (const p of PRIVILEGE_PROBES) expect({ name: p.name, noRows: /WHERE false/.test(p.sql) }).toEqual({ name: p.name, noRows: true })
  })
})
