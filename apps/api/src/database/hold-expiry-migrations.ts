export interface MigrationRow { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }

export interface MigrationAssessment {
  applied: string[]
  pending: string[]
  failed: string[]
  unknownApplied: string[]
  unexpectedPending: string[]
  safeToApply: boolean
}

/** Pure read-only comparison of repo migration folders against _prisma_migrations. */
export function assessMigrations(directories: string[], rows: MigrationRow[], expectedPending: string[]): MigrationAssessment {
  const failed = rows.filter(row => row.rolled_back_at !== null || row.finished_at === null).map(row => row.migration_name).sort()
  const applied = rows.filter(row => row.finished_at !== null && row.rolled_back_at === null).map(row => row.migration_name).sort()
  const known = new Set(directories)
  const appliedSet = new Set(applied)
  const pending = [...directories].sort().filter(name => !appliedSet.has(name) && !failed.includes(name))
  const unknownApplied = applied.filter(name => !known.has(name))
  const expected = new Set(expectedPending)
  const unexpectedPending = pending.filter(name => !expected.has(name))
  return { applied, pending, failed, unknownApplied, unexpectedPending, safeToApply: failed.length === 0 && unknownApplied.length === 0 && unexpectedPending.length === 0 }
}
