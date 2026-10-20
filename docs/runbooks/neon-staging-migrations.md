# Neon staging migrations and production protection

ADR 0075. Applies every pending Prisma migration to a fresh copy of production (`staging`), certifies it, and only then lets the owner migrate
production. Never run `prisma migrate dev` or `db push` against either branch. Never paste a connection string into a ticket, log or chat: the
repository and its Actions logs are public.

## One-time setup (owner)

1. **Protect production and set the PITR window.** From an operator shell with a Neon API key:
   ```
   NEON_API_KEY=… NEON_PROJECT_ID=… scripts/neon-staging-branch.sh protect --production main --retention-days 7 [--allowed-ips 203.0.113.0/24]
   ```
   `main` becomes a protected branch (cannot be deleted, reset or archived; child branches receive new role passwords; an IP allowlist can be
   scoped to protected branches only). The restore window is the plan's `history_retention_seconds` (Launch: up to 7 days, Scale: up to 30).
   Protected branches are a paid-plan feature. `status` shows the result at any time.
2. **GitHub environment `neon-staging`:** required reviewer, deployment branches limited to `main`, secret `NEON_API_KEY`, variable
   `NEON_PROJECT_ID` (optionally `NEON_DATABASE`, `NEON_OWNER_ROLE`; defaults `neondb`, `neondb_owner`). The API key can read every branch's
   credentials, so it lives nowhere else. Production's owner credential is never stored in GitHub.

## Rehearse on staging (every release that carries migrations)

Actions → *Neon staging migration* → Run workflow on `main`. Leave **reset** on; optionally set **expect pending** to the count you expect
(for example `91`). The workflow:

1. `neon-staging-branch.sh create --reset`: staging = production's current head; previous staging kept as `staging-before-<time>`; staging owner
   password rotated.
2. `neon-staging-branch.sh env`: staging owner URL (direct endpoint) and every production host (direct and pooled) as a denylist, into a masked
   0600 runner file. Refuses protected/default branches.
3. `migrate-staging.sh --reprovision-runtime-role`: the full governed run (below), with a fresh random runtime login password.
4. Uploads `staging-migration-evidence/` (names, counts, checksums, timings; no hosts, URLs or rows).

The same from an operator shell (`pnpm install` first; needs `psql`):
```
scripts/neon-staging-branch.sh create --reset
scripts/neon-staging-branch.sh env --env-file ./staging.env      # 0600; delete it afterwards
set -a; . ./staging.env; set +a
API_RUNTIME_LOGIN_PASSWORD="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
  scripts/migrate-staging.sh --reprovision-runtime-role --expect-pending 91
rm ./staging.env
```
`--dry-run` stops after the read-only checks. Equivalent raw neonctl commands, for reference: `neonctl branches create --name staging --parent main`,
`neonctl branches reset staging --parent --preserve-under-name staging-before-<time>`, `neonctl connection-string staging --role-name neondb_owner`.

### What `migrate-staging.sh` checks

| Step | Fails when |
|---|---|
| target guards | no owner URL; pooled `-pooler` endpoint; remote without `sslmode=require/verify-*`; host is a declared production host; no production denylist for a remote target; runtime URL missing, equal to the owner URL or on another endpoint; dirty working tree |
| committed chain | a name is not `<12 or 14-digit UTC ID>_<snake_case>`; invalid date or time; missing/empty `migration.sql`; stray file; lock provider not PostgreSQL; a **new** ID collision |
| history before | the database records a migration this commit lacks; a started-but-unfinished migration; an applied migration was edited (checksum); a pending migration sorts before an applied one (would apply out of chronological order); pending count ≠ `--expect-pending` |
| `migrate deploy` | Prisma fails (owner credential passed to this command only, through `with-migration-url.cjs`) |
| history after | anything still pending; this run applied a different number than was pending, or not in chain order |
| `migrate status` | not up to date |
| schema drift | migrated schema ≠ `prisma/schema.prisma` (beyond the documented, unmodellable indexes) |
| role re-provision | `ops:provision-api-runtime-role` fails (REVOKE ALL, then exactly the contract) |
| ownership / forced RLS | a table is owned by a runtime role, lacks `FORCE ROW LEVEL SECURITY` without a documented exemption, or the runtime group can CREATE |
| rollout status | a blocker, or any grant drift from the runtime contract |
| runtime login probes | the login is superuser/BYPASSRLS/owns objects, or a probe that must be denied is allowed (or vice versa) |

Verdicts: `STAGING_CERTIFIED` (all passed), `MIGRATED_RUNTIME_ROLE_UNVERIFIED` (`--skip-runtime-verify`; not sufficient for production),
`DRY_RUN_NO_CHANGES`, `FAILED` (with the failing step). A failed migration on staging is never repaired with `migrate resolve`: fix the migration
in a new commit and rerun with `--reset`.

## Production (owner, maintenance window)

Only with evidence `STAGING_CERTIFIED` whose `gitSha` is the commit being released and whose `chain.digest` equals
`node tools/migration-ledger-check.mjs chain` on that commit.

1. `scripts/neon-staging-branch.sh restore-point --production main --label <git sha>`: a compute-less branch at production's head plus the exact
   `neonctl branches restore main ^self@<time>` command. Keep its output with the change record.
2. Migrate from a trusted shell with the production owner URL (direct endpoint), per [api-deploy.md](api-deploy.md) step 2:
   `MIGRATION_DATABASE_URL=<owner url> pnpm --filter @bedbanks/api prisma:migrate:deploy:owner`, then `prisma:migrate:status:owner`.
   On AWS, run the one-off task (image `<sha>-migrate`, [aws-ecs-deployment.md](aws-ecs-deployment.md) step 4).
3. Re-provision and verify the runtime role exactly as staging did ([strict-role-rollout.md](strict-role-rollout.md)), deploy the image, smoke
   test. Delete the restore-point branch once the release is accepted.
4. **Undo:** schema migrations are forward-only. If the release must be rolled back with data, restore production with the command printed in step
   1 (the current state is preserved under a new name), then redeploy the previous image. Writes made after the restore point are in the preserved
   branch, not in production.

## Migration IDs

Prisma applies migrations in lexicographic name order. Use the next ID after the highest existing one (`ls apps/api/prisma/migrations | tail -1`),
even though 63 existing IDs are dated after their commit date. Eight historical IDs are shared by two migrations each; they are already applied and
listed in `KNOWN_ID_COLLISIONS` (`tools/migration-ledger-check.mjs`). CI rejects any new collision.
