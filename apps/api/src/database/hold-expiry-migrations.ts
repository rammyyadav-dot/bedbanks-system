export interface MigrationRow { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }

export interface MigrationAssessment {
  applied: string[]
  pending: string[]
  /** Unresolved failures: started, never finished, not marked rolled back. Prisma refuses to deploy over these. */
  failed: string[]
  /** Historical rows already marked rolled back (resolved by a repair). Informational only. */
  rolledBack: string[]
  unknownApplied: string[]
  unexpectedPending: string[]
  safeToApply: boolean
}

/**
 * Pure read-only comparison of repo migration folders against _prisma_migrations,
 * using Prisma's own semantics: only a row that has neither finished nor been
 * marked rolled back blocks a deploy. `allowCatchUp` (nonprod only) accepts any
 * number of pending migrations; it never accepts failures or unknown migrations.
 */
export function assessMigrations(directories: string[], rows: MigrationRow[], expectedPending: string[], options: { allowCatchUp?: boolean } = {}): MigrationAssessment {
  const failed = unique(rows.filter(row => row.finished_at === null && row.rolled_back_at === null).map(row => row.migration_name))
  const rolledBack = unique(rows.filter(row => row.rolled_back_at !== null).map(row => row.migration_name))
  const applied = unique(rows.filter(row => row.finished_at !== null && row.rolled_back_at === null).map(row => row.migration_name))
  const known = new Set(directories)
  const appliedSet = new Set(applied)
  const pending = [...directories].sort().filter(name => !appliedSet.has(name) && !failed.includes(name))
  const unknownApplied = applied.filter(name => !known.has(name))
  const expected = new Set(expectedPending)
  const unexpectedPending = options.allowCatchUp ? [] : pending.filter(name => !expected.has(name))
  return { applied, pending, failed, rolledBack, unknownApplied, unexpectedPending, safeToApply: failed.length === 0 && unknownApplied.length === 0 && unexpectedPending.length === 0 }
}

function unique(names: string[]): string[] { return [...new Set(names)].sort() }
