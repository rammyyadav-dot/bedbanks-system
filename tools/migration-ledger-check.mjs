// Migration ledger guard (ADR 0075). Two checks, both read-only and database-client free:
//
//   node tools/migration-ledger-check.mjs chain [--json]
//     The committed chain in apps/api/prisma/migrations: names, IDs, order, SQL present, lock provider. Runs in CI on every change.
//
//   psql ... | node tools/migration-ledger-check.mjs history --phase=before [--expect-pending=91]
//   psql ... | node tools/migration-ledger-check.mjs history --phase=after --since=<ISO-8601> --expect-applied=91
//     Compares a target database's "_prisma_migrations" rows (JSON array on stdin) with the chain: unknown or failed history, edited migrations,
//     pending migrations that would apply out of order, and, after a deploy, that this run applied exactly the pending set in chain order.
//
// Prisma applies migrations in lexicographic directory-name order. A valid name starts with its UTC date, so that order is also chronological; the risk is a
// pending migration that sorts before one the database already applied, which the history check rejects.
// Prints a JSON summary on stdout (names, counts and checksums only: never URLs, hosts or row data) and exits 1 with the failures on stderr.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../apps/api/prisma/migrations/', import.meta.url))

// 12 digits: UTC date + a four-digit sequence for that day. 14 digits: UTC date and time (Prisma's own format).
const NAME = /^(?<id>(?<date>\d{8})(?:\d{4}|\d{6}))_[a-z0-9_]+$/

/**
 * IDs shared by two committed migrations. All of them are already applied in history, and Prisma records migrations by full name, so renaming one now
 * would orphan its history row. Each pair applies in name-suffix order, which matches how it was applied. Never add to this list: give a new migration
 * the next free ID instead.
 */
export const KNOWN_ID_COLLISIONS = new Set([
  '202609230001', '202610180001', '202611160001', '202611170001', '202611180001', '202611200001', '202611230001', '202611250001',
])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function validDate(yyyymmdd) {
  const [y, m, d] = [yyyymmdd.slice(0, 4), yyyymmdd.slice(4, 6), yyyymmdd.slice(6, 8)].map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** One chain entry from a directory name and its migration.sql bytes (null when the file is missing). */
export function parseMigration(name, sql) {
  const match = NAME.exec(name)
  return { name, id: match?.groups.id ?? null, date: match?.groups.date ?? null, checksum: sql ? sha256(sql) : null, empty: !sql || sql.toString('utf8').trim() === '' }
}

/** Reads the committed chain. Each entry: name, ID, UTC date and the SHA-256 of migration.sql (the value Prisma stores as the checksum). */
export function readChain(dir = MIGRATIONS_DIR) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const lock = existsSync(join(dir, 'migration_lock.toml')) ? readFileSync(join(dir, 'migration_lock.toml'), 'utf8') : null
  const migrations = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().map((name) => {
    const sqlPath = join(dir, name, 'migration.sql')
    return parseMigration(name, existsSync(sqlPath) ? readFileSync(sqlPath) : null)
  })
  const strays = entries.filter((e) => !e.isDirectory() && e.name !== 'migration_lock.toml').map((e) => e.name)
  return { migrations, lock, strays }
}

/** Failures in the committed chain itself. `today` (YYYYMMDD) only reports future-dated IDs; they are not a failure (see the runbook). */
export function checkChain({ migrations, lock, strays }, { today = new Date().toISOString().slice(0, 10).replaceAll('-', ''), knownCollisions = KNOWN_ID_COLLISIONS } = {}) {
  const failures = []
  if (!lock || !/provider\s*=\s*"postgresql"/.test(lock)) failures.push('migration_lock.toml is missing or does not pin provider = "postgresql"')
  for (const name of strays) failures.push(`${name}: unexpected file in the migrations directory (each migration is a directory holding migration.sql)`)
  if (migrations.length === 0) failures.push('no migrations found')
  const byId = new Map()
  for (const m of migrations) {
    if (!m.id) { failures.push(`${m.name}: name must be <12- or 14-digit UTC ID>_<lower_snake_case>`); continue }
    if (!validDate(m.date)) failures.push(`${m.name}: ${m.date} is not a valid UTC calendar date`)
    if (m.id.length === 14 && !/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(m.id.slice(8))) failures.push(`${m.name}: ${m.id.slice(8)} is not a valid UTC time`)
    if (m.empty) failures.push(`${m.name}: migration.sql is missing or empty`)
    byId.set(m.id, [...(byId.get(m.id) ?? []), m.name])
  }
  for (const [id, names] of byId) if (names.length > 1 && !knownCollisions.has(id)) failures.push(`ID collision ${id}: ${names.join(', ')} (give the newer migration the next free ID)`)
  for (const id of knownCollisions) if ((byId.get(id) ?? []).length !== 2) failures.push(`known collision ${id} no longer matches the chain: a committed migration was renamed or removed`)
  const futureDated = migrations.filter((m) => m.date && m.date > today).map((m) => m.name)
  return { failures, futureDated }
}

/** SHA-256 over every name and checksum, in apply order: one value that identifies the exact chain a staging run certified. */
export function chainDigest(migrations) {
  return sha256(migrations.map((m) => `${m.name}\t${m.checksum}\n`).join(''))
}

/**
 * Compares database history rows with the chain. Rows: { migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count }.
 * phase 'before': the target may be behind, never ahead, diverged or broken. phase 'after': nothing pending, and the rows this run wrote
 * (started_at >= since) are exactly `expectApplied` migrations, applied in chain order.
 */
export function checkHistory(rows, migrations, { phase, since = null, expectPending = null, expectApplied = null }) {
  const failures = []
  const chain = new Map(migrations.map((m) => [m.name, m]))
  const live = rows.filter((r) => !r.rolled_back_at)
  const failed = live.filter((r) => !r.finished_at)
  const applied = live.filter((r) => r.finished_at)
  const unknown = [...new Set(rows.map((r) => r.migration_name).filter((name) => !chain.has(name)))]
  for (const name of unknown) failures.push(`${name}: applied in the database but not in this commit (the database is ahead of, or diverged from, this branch)`)
  for (const r of failed) failures.push(`${r.migration_name}: started but never finished (failed migration; resolve it per the repair runbook before deploying)`)
  const appliedNames = new Set()
  for (const r of applied) {
    if (appliedNames.has(r.migration_name)) failures.push(`${r.migration_name}: recorded as applied more than once`)
    appliedNames.add(r.migration_name)
    const committed = chain.get(r.migration_name)
    if (committed && committed.checksum !== r.checksum) failures.push(`${r.migration_name}: committed migration.sql differs from the applied checksum (an applied migration was edited)`)
  }
  const pending = migrations.filter((m) => !appliedNames.has(m.name)).map((m) => m.name)
  const lastApplied = migrations.filter((m) => appliedNames.has(m.name)).at(-1)?.name ?? null
  const outOfOrder = lastApplied ? pending.filter((name) => name < lastApplied) : []
  for (const name of outOfOrder) failures.push(`${name}: pending but sorts before the already-applied ${lastApplied}, so it would apply out of chronological order (give it a later ID)`)
  if (phase === 'before' && expectPending !== null && pending.length !== expectPending) failures.push(`expected ${expectPending} pending migrations, found ${pending.length}`)
  let appliedThisRun = null
  if (phase === 'after') {
    if (pending.length) failures.push(`${pending.length} migration(s) still pending after deploy: ${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ', ...' : ''}`)
    if (since) {
      const run = applied.filter((r) => new Date(r.started_at) >= new Date(since)).sort((a, b) => new Date(a.started_at) - new Date(b.started_at))
      appliedThisRun = run.length
      const names = run.map((r) => r.migration_name)
      if (names.join('\n') !== [...names].sort().join('\n')) failures.push('this run applied migrations in an order that differs from the chain order')
      if (expectApplied !== null && run.length !== expectApplied) failures.push(`expected this run to apply ${expectApplied} migrations, it applied ${run.length}`)
    }
  }
  return {
    failures,
    summary: {
      chain: migrations.length, applied: appliedNames.size, pending: pending.length, firstPending: pending[0] ?? null, lastPending: pending.at(-1) ?? null,
      lastApplied, rolledBackRows: rows.length - live.length, resolvedWithoutExecution: applied.filter((r) => r.applied_steps_count === 0).length,
      unknown: unknown.length, failed: failed.length, outOfOrder: outOfOrder.length, ...(appliedThisRun === null ? {} : { appliedThisRun }),
    },
  }
}

function option(args, name) {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

function main(args) {
  const [mode] = args
  const chain = readChain(option(args, 'dir') ?? MIGRATIONS_DIR)
  const { failures: chainFailures, futureDated } = checkChain(chain)
  const base = { count: chain.migrations.length, first: chain.migrations[0]?.name ?? null, last: chain.migrations.at(-1)?.name ?? null, digest: chainDigest(chain.migrations), futureDated: futureDated.length }
  let failures = chainFailures
  let out = base
  if (mode === 'history') {
    const phase = option(args, 'phase')
    if (phase !== 'before' && phase !== 'after') throw new Error('history needs --phase=before|after')
    const rows = JSON.parse(readFileSync(0, 'utf8') || '[]')
    if (!Array.isArray(rows)) throw new Error('stdin must be a JSON array of _prisma_migrations rows')
    const num = (name) => (option(args, name) === null ? null : Number(option(args, name)))
    const result = checkHistory(rows, chain.migrations, { phase, since: option(args, 'since'), expectPending: num('expect-pending'), expectApplied: num('expect-applied') })
    failures = [...failures, ...result.failures]
    out = { chain: base, database: result.summary }
  } else if (mode !== 'chain') {
    throw new Error('usage: migration-ledger-check.mjs chain|history [--phase=before|after] [--since=ISO] [--expect-pending=N] [--expect-applied=N] [--json]')
  }
  if (mode === 'history' || args.includes('--json')) console.log(JSON.stringify(out))
  else console.log(`Migration chain: ${base.count} migrations (${base.first} .. ${base.last}), digest ${base.digest}; ${base.futureDated} dated after today.`)
  if (failures.length) { console.error(`Migration ledger check failed:\n- ${failures.join('\n- ')}`); process.exitCode = 1 }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2 }
}
