// Migration safety gate for PostgreSQL on Neon (CLAUDE.md change protocol; ADR 0075 migration ledger covers chain integrity, this covers content).
//
//   node tools/migration-safety-check.mjs [--base=origin/main] [--json]
//
// 1. Schema: every foreign-key field in schema.prisma must be the leading column of an @@index/@@unique/@@id (or a field-level @id/@unique).
//    PostgreSQL does not index the referencing side of a foreign key; without one, deletes/updates on the parent seq-scan the child table while
//    holding locks, which on a pooled Neon endpoint shows up as lock queues and exhausted connections. Existing gaps live in
//    security/migration-safety-baseline.json and only ratchet down.
// 2. Migrations added or changed since --base (CI passes the PR base; --all rescans history, which is noisy by design because applied migrations are immutable): breaking or lock-heavy statements must carry
//    `-- migration-safety: allow <rule> <reason>` on the line above (reason mandatory). Rules:
//      drop-table, drop-column, alter-type, set-not-null, rename, drop-constraint, truncate, unbounded-write, create-index-blocking, raw-secret
//    * set-not-null / alter-type / create-index-blocking take ACCESS EXCLUSIVE or SHARE locks that block writes for the table's rewrite/scan time.
//      Plain CREATE INDEX is accepted on tables created in the same migration (empty) and otherwise needs the marker.
//    * unbounded-write is an UPDATE/DELETE with no WHERE.
//    * raw-secret is a credential literal in a migration (CREATE ROLE ... PASSWORD '...'): roles are provisioned with a secret supplied at deploy time.
// Historical migrations are immutable once applied (see apps/api/prisma/MIGRATIONS.md), so unchanged files are never re-checked.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PRISMA_DIR = join(ROOT, 'apps/api/prisma')

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** Returns "Model.field" names of foreign-key fields that no index/unique/id leads with. */
export function unindexedForeignKeys(schema) {
  const missing = []
  for (const [, model, body] of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const leading = new Set()
    const fks = []
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim()
      const rel = /@relation\([^)]*fields:\s*\[([^\]]*)\]/.exec(line)
      if (rel) fks.push(rel[1].split(',')[0].trim())
      const field = /^(\w+)\s+\S+.*(?:@id|@unique)\b/.exec(line)
      if (field && !line.startsWith('@@')) leading.add(field[1])
      const block = /^@@(?:index|unique|id)\(\s*(?:fields:\s*)?\[([^\]]*)\]/.exec(line)
      if (block) leading.add(block[1].split(',')[0].trim().replace(/\(.*$/, ''))
    }
    for (const fk of fks) if (!leading.has(fk)) missing.push(`${model}.${fk}`)
  }
  return missing.sort()
}

const RULES = [
  ['drop-table', /\bDROP\s+TABLE\b/i],
  ['drop-column', /\bDROP\s+COLUMN\b/i],
  ['alter-type', /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i],
  ['set-not-null', /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i],
  ['rename', /\bRENAME\s+(?:COLUMN|TO)\b|\bALTER\s+TABLE\s+\S+\s+RENAME\b/i],
  ['drop-constraint', /\bDROP\s+CONSTRAINT\b/i],
  ['truncate', /\bTRUNCATE\b/i],
  ['unbounded-write', /^\s*(?:UPDATE\s+\S+\s+SET\b(?![^;]*\bWHERE\b)|DELETE\s+FROM\s+\S+\s*;)/i],
  ['raw-secret', /\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\b[^;]*\bPASSWORD\s+'[^']{3,}'/i],
]

export function checkMigration(name, sql) {
  const problems = []
  const clean = stripComments(sql)
  const created = new Set([...clean.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map((m) => m[1]))
  const lines = clean.split('\n')
  // Statement-level scan: join each statement (terminated by ';') and attribute it to its first line.
  let buf = ''
  let start = 0
  const statements = []
  lines.forEach((line, i) => {
    if (!buf.trim()) start = i
    if (/^\s*--/.test(line)) { if (!buf.trim()) start = i + 1; return }
    buf += line + '\n'
    if (/;\s*$/.test(line)) { statements.push({ text: buf, line: start }); buf = '' }
  })
  if (buf.trim()) statements.push({ text: buf, line: start })
  const allowed = (stmt, rule) => {
    const above = sql.split('\n').slice(Math.max(0, stmt.line - 3), stmt.line + 1).join('\n')
    return new RegExp(`--\\s*migration-safety:\\s*allow[ \\t]+${rule}[ \\t]+\\S+`).test(above)
  }
  for (const stmt of statements) {
    const text = stmt.text.replace(/'(?:[^']|'')*'/g, (m) => (/PASSWORD\s*$/i.test(stmt.text.slice(0, stmt.text.indexOf(m))) ? m : "''"))
    for (const [rule, re] of RULES) {
      if (re.test(rule === 'raw-secret' ? stmt.text : text) && !allowed(stmt, rule)) {
        problems.push(`${name}:${stmt.line + 1} [${rule}] ${stmt.text.trim().split('\n')[0].slice(0, 90)} (add "-- migration-safety: allow ${rule} <reason>" above the statement once reviewed)`)
      }
    }
    const idx = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!CONCURRENTLY)\S+\s+ON\s+(?:ONLY\s+)?"?(\w+)"?/i.exec(text)
    if (idx && !created.has(idx[1]) && !allowed(stmt, 'create-index-blocking')) {
      problems.push(`${name}:${stmt.line + 1} [create-index-blocking] index on existing table "${idx[1]}" blocks writes while it builds (add "-- migration-safety: allow create-index-blocking <reason: table size>" once reviewed)`)
    }
  }
  return problems
}

function changedMigrations(base) {
  const all = readdirSync(join(PRISMA_DIR, 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  if (!base) return process.argv.includes('--all') ? all : []
  const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', 'apps/api/prisma/migrations'], { cwd: ROOT, encoding: 'utf8' })
  return [...new Set(diff.split('\n').map((p) => p.split('/')[4]).filter(Boolean))].filter((n) => all.includes(n))
}

export function evaluate({ schema, baseline, migrations }) {
  const problems = []
  const missing = unindexedForeignKeys(schema)
  const known = new Set(baseline.unindexedForeignKeys ?? [])
  for (const fk of missing) if (!known.has(fk)) problems.push(`schema.prisma: foreign key ${fk} has no leading index (add @@index([...]) or @@unique); PostgreSQL does not index referencing columns`)
  for (const fk of known) if (!missing.includes(fk)) problems.push(`security/migration-safety-baseline.json: ${fk} is now indexed or gone; remove it from the baseline`)
  for (const [name, sql] of Object.entries(migrations)) problems.push(...checkMigration(name, sql))
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7)
  const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8')
  const baselineFile = join(ROOT, 'security/migration-safety-baseline.json')
  if (process.argv.includes('--write-baseline')) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(baselineFile, JSON.stringify({ unindexedForeignKeys: unindexedForeignKeys(schema) }, null, 2) + '\n')
    console.log('baseline written')
    process.exit(0)
  }
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {}
  const names = changedMigrations(base)
  const migrations = Object.fromEntries(names.map((n) => [n, readFileSync(join(PRISMA_DIR, 'migrations', n, 'migration.sql'), 'utf8')]))
  const problems = evaluate({ schema, baseline, migrations })
  if (problems.length) { console.error(`Migration safety check failed (${problems.length}):\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log(`Migration safety check: ${names.length} migration(s) scanned${base ? ` since ${base}` : ''}; foreign keys indexed apart from ${(baseline.unindexedForeignKeys ?? []).length} baselined.`)
}
