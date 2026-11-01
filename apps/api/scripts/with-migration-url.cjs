#!/usr/bin/env node
// P0-01 (ADR 0040): runs a command with the migration/owner credential, and only that command.
//
//   node scripts/with-migration-url.cjs prisma migrate deploy --schema=prisma/schema.prisma
//
// MIGRATION_DATABASE_URL (owner, schema changes) is copied into DATABASE_URL for the CHILD process only, because the Prisma datasource reads DATABASE_URL.
// The long-running API never receives it: its own DATABASE_URL is the restricted login. Refuses when the two are equal (a runtime URL used as a migration URL
// would mean the runtime login owns the schema, or the owner is serving requests). Never prints a URL.
const { spawnSync } = require('node:child_process')

const migration = process.env.MIGRATION_DATABASE_URL
if (!migration) { console.error('MIGRATION_DATABASE_URL is required (the owner credential, used for this command only).'); process.exit(2) }
let user
try { user = decodeURIComponent(new URL(migration).username) } catch { console.error('MIGRATION_DATABASE_URL is not a valid URL.'); process.exit(2) }
if (process.env.DATABASE_URL && process.env.DATABASE_URL === migration) {
  console.error('MIGRATION_DATABASE_URL must differ from DATABASE_URL: the runtime login must never be the migration owner.'); process.exit(2)
}
if (/^fbeds_(api|booking|hold)/.test(user)) { console.error(`MIGRATION_DATABASE_URL names a runtime login ("${user}"); migrations need the owner.`); process.exit(2) }
const [command, ...args] = process.argv.slice(2)
if (!command) { console.error('usage: with-migration-url.cjs <command> [args...]'); process.exit(2) }
const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: migration }, shell: false })
process.exit(result.status ?? 1)
