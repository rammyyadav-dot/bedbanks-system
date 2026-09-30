# Runbook: provision the hold-expiry background role

Closes the operational half of ADR 0005. Executed by the **database owner**, not
by CI or an AI session. Nothing here touches production until a human runs it.

## Fastest route: the GitHub workflow (no terminal)
The manual workflow **Provision hold-expiry role** performs steps 2 to 4 below from
GitHub. It only runs from `main`, reads secrets from a GitHub Environment, never
prints a URL or password, and defaults to a read-only check.

One-time setup (repository owner, in GitHub: Settings -> Environments):
1. Create environments `db-nonprod` and `db-production`. On `db-production` add
   yourself (or another person) under **Required reviewers**, and restrict both
   to the `main` branch.
2. In each environment add **secrets**:
   - `OWNER_DATABASE_URL`: the Neon **direct** (pooling off) owner connection
     string for that branch. Paste it into the secret box; do not screenshot it.
   - `HOLD_EXPIRY_LOGIN_PASSWORD`: a new 32+ character URL-safe password. Use the
     same value later inside `HOLD_EXPIRY_DATABASE_URL`.
3. Optional environment **variable** `HOLD_EXPIRY_LOGIN_ROLE` (default
   `fbeds_hold_expiry_login`).

Run (Actions -> Provision hold-expiry role -> Run workflow):
1. `target=nonprod`, `mode=status-only`, `confirm_database=<database name>` first.
   Expect "Migration state: as expected". Any other result stops with a clear message.
2. `target=nonprod`, `mode=apply` to rehearse, then the same two runs for `production`.
3. The run summary ends with "Role check passed". Then set
   `HOLD_EXPIRY_DATABASE_URL` where the API runs and only then enable the sweeper.

The workflow refuses: a pooled connection string, a mismatched database name,
unresolved failed migrations (started, never finished, not marked rolled back),
migrations the repo does not know, and any pending migration other than
`202609280001_hold_expiry_system_audit_policy`. Rows an earlier repair already
marked rolled back are reported and ignored, matching Prisma's behaviour.

A nonprod branch that is several migrations behind can be brought up with the
**allow_catch_up** tick-box. It is refused for `production`, where only the one
expected migration may be pending. If production is behind, stop and follow
`docs/production-migration-repair-runbook-2026-09-27.md` instead.

## 0. Preconditions
- The migration `202609280001_hold_expiry_system_audit_policy` is deployed
  (`prisma migrate deploy` through the normal, approved release process).
- A verified backup / restore point exists (see `docs/postgres-production-release-checklist.md`).
- The owner has approved the change and a change window.

## 1. Generate the credential
Generate a 32+ character URL-safe secret in your secret manager
(`openssl rand -base64 30 | tr '+/' '-_' | tr -d '='`). Do not paste it in chat,
tickets or logs.

## 2. Provision (owner credential)
```
PROVISION_DATABASE_URL=<owner URL from secret manager> \
HOLD_EXPIRY_LOGIN_PASSWORD=<secret from step 1> \
pnpm --filter @bedbanks/api ops:provision-hold-expiry-role \
  --allow-remote --confirm-database=<exact database name>
```
The command is idempotent and re-running it rotates the password. It creates the
NOLOGIN group role `fbeds_hold_expiry` and a LOGIN member (default
`fbeds_hold_expiry_login`), both with no SUPERUSER, BYPASSRLS, CREATEROLE,
CREATEDB or REPLICATION, and grants only:

| Object | Privilege |
|---|---|
| `tenants` | SELECT (`id`, `status`) |
| `InventoryHold` | SELECT; UPDATE (`status`, `released_at`, `updated_at`) |
| `InventoryHoldNight` | SELECT |
| `DailyAvailability` | SELECT; UPDATE (`held`, `updated_at`) |
| `AuditEvent` | SELECT, INSERT (policy limits INSERT to the SYSTEM `inventory.hold.expired` event in the current tenant) |

## 3. Store the runtime setting
Build `HOLD_EXPIRY_DATABASE_URL` from the same host and database with the login
role and secret, and store it as a **secret reference** in the API runtime
environment. It must differ from `DATABASE_URL`. Do not commit it.

## 4. Verify before enabling
Connect as the login role and confirm `verifyHoldExpiryRole` passes (attributes,
group membership, no table ownership, no access to users, sessions, finance or
booking tables). The PostgreSQL e2e suite (`test/inventory-hold.e2e-spec.ts`,
"restricted hold-expiry database role") is the executable specification and also
proves the role cannot forge other audit events, change allotment or sold, or
cross tenants.

## 5. Enable
Set `HOLD_EXPIRY_SWEEP_ENABLED=true` and restart the API. It fails fast if the
credential is missing or equals `DATABASE_URL`. Watch for
`Hold expiry pass:` and `Hold expiry failed` log lines for the first day.

## Residual risks (accepted, reviewed)
- The role can read AuditEvent rows of the tenant in context (needed for INSERT ... RETURNING).
- The role sees every active tenant's holds by design (the sweeper is cross-tenant); RLS still applies per tenant context.
- Several API instances each run a sweeper; release only acts on rows still HELD, so this is safe but redundant.

## Rollback
1. `HOLD_EXPIRY_SWEEP_ENABLED=false`, restart.
2. Revoke: `DROP OWNED BY "<login role>"; DROP ROLE "<login role>";` (and the group role if unused).
3. Policy rollback SQL is in the migration header (forward migration, reviewed first).
