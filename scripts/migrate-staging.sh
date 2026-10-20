#!/usr/bin/env bash
# Governed Prisma migration run against the Neon `staging` branch (ADR 0075, docs/runbooks/neon-staging-migrations.md).
#
#   MIGRATION_DATABASE_URL=<staging owner URL, DIRECT endpoint> \
#   PRODUCTION_DATABASE_HOSTS=<comma-separated production endpoint hosts this run must refuse> \
#   API_RUNTIME_LOGIN_PASSWORD=<fresh staging-only secret>   # with --reprovision-runtime-role
#   API_DATABASE_URL=<staging fbeds_api_login URL>            # otherwise, unless --skip-runtime-verify
#   scripts/migrate-staging.sh [--expect-pending N] [--reprovision-runtime-role] [--skip-runtime-verify] [--dry-run] [--allow-dirty] [--evidence-dir DIR]
#
# Order: target guards -> committed chain check -> prisma validate -> connect (wakes a suspended Neon compute) -> history BEFORE (unknown, failed,
# edited, out-of-order, expected pending count) -> migrate status -> migrate deploy (owner credential, this command only) -> history AFTER (nothing
# pending, exactly the pending set applied, in chain order) -> migrate status (must be clean) -> schema drift -> [re-provision runtime role] ->
# ownership + forced RLS audit -> rollout status (no blockers, no grant drift) -> runtime login verification -> evidence JSON.
#
# Never prints a URL, host or password: Prisma's datasource line is redacted and the evidence file holds names, counts and checksums only (the
# repository and its Actions logs are public). Exit 0 only when every step passed; the evidence verdict is then STAGING_CERTIFIED, which is the input
# to a production change request, never an authorization to migrate production.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECT_PENDING=""
REPROVISION=false
SKIP_RUNTIME_VERIFY=false
DRY_RUN=false
ALLOW_DIRTY=false
EVIDENCE_DIR="$ROOT/staging-migration-evidence"

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-pending) EXPECT_PENDING="${2:?--expect-pending needs a number}"; shift 2 ;;
    --expect-pending=*) EXPECT_PENDING="${1#*=}"; shift ;;
    --reprovision-runtime-role) REPROVISION=true; shift ;;
    --skip-runtime-verify) SKIP_RUNTIME_VERIFY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs a path}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done
[ -z "$EXPECT_PENDING" ] || [[ "$EXPECT_PENDING" =~ ^[0-9]+$ ]] || { echo "--expect-pending must be a non-negative integer" >&2; exit 2; }

# ---------- state, logging, evidence ----------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STEPS="$WORK/steps.tsv"; : > "$STEPS"
RUN_STARTED_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CURRENT_STEP="setup"
FINISHED=false

log() { printf '[migrate-staging] %s\n' "$*" >&2; }
# Prisma prints `PostgreSQL database "<db>", schema "public" at "<host>"`; drivers may echo a URL. Neither reaches the log.
redact() { sed -E -e 's/( at )"[^"]*"/\1"<redacted>"/g' -e 's#postgres(ql)?://[^[:space:]"'"'"']+#<redacted-url>#g'; }
record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$STEPS"; }

# step <label> <command...>: runs, times and records one step; output is redacted. A failing step ends the run (set -e) after it is recorded.
step() {
  local label="$1"; shift
  CURRENT_STEP="$label"
  log "-> $label"
  local start=$SECONDS status=0
  # Inside a `||` list bash suppresses errexit and the ERR trap for the whole command, so every step function returns its own status explicitly.
  "$@" 2>&1 | redact >&2 || status=${PIPESTATUS[0]}
  record "$label" "$([ "$status" -eq 0 ] && echo pass || echo "fail($status)")" "$((SECONDS - start))"
  return "$status"
}

write_evidence() {
  local verdict="$1"
  mkdir -p "$EVIDENCE_DIR"
  local file
  file="$EVIDENCE_DIR/staging-migration-$(date -u +%Y%m%dT%H%M%SZ).json"
  VERDICT="$verdict" FAILED_STEP="${2:-}" STEPS_FILE="$STEPS" WORK="$WORK" RUN_STARTED_UTC="$RUN_STARTED_UTC" GIT_SHA="${GIT_SHA:-unknown}" GIT_DIRTY="${GIT_DIRTY:-unknown}" \
  TARGET_DATABASE="${TARGET_DATABASE:-unknown}" TARGET_KIND="${TARGET_KIND:-unknown}" DEPLOY_SECONDS="${DEPLOY_SECONDS:-}" DRY_RUN="$DRY_RUN" \
  REPROVISION="$REPROVISION" SKIP_RUNTIME_VERIFY="$SKIP_RUNTIME_VERIFY" node - "$file" <<'NODE'
const fs = require('node:fs')
const read = (name) => { try { return JSON.parse(fs.readFileSync(`${process.env.WORK}/${name}`, 'utf8')) } catch { return null } }
const steps = fs.readFileSync(process.env.STEPS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [label, status, seconds] = l.split('\t'); return { label, status, seconds: Number(seconds) } })
const before = read('history-before.json'), after = read('history-after.json')
const applied = after?.database?.appliedThisRun ?? null, deploySeconds = process.env.DEPLOY_SECONDS ? Number(process.env.DEPLOY_SECONDS) : null
const evidence = {
  kind: 'fbeds-staging-migration', verdict: process.env.VERDICT, failedStep: process.env.FAILED_STEP || null, productionAuthorization: false,
  startedAt: process.env.RUN_STARTED_UTC, finishedAt: new Date().toISOString(), gitSha: process.env.GIT_SHA, workingTreeDirty: process.env.GIT_DIRTY === 'true',
  target: { database: process.env.TARGET_DATABASE, kind: process.env.TARGET_KIND },
  options: { dryRun: process.env.DRY_RUN === 'true', reprovisionRuntimeRole: process.env.REPROVISION === 'true', runtimeVerifySkipped: process.env.SKIP_RUNTIME_VERIFY === 'true' },
  chain: before?.chain ?? null, before: before?.database ?? null, after: after?.database ?? null,
  metrics: { migrationsApplied: applied, deploySeconds, migrationsPerMinute: applied && deploySeconds ? Math.round((applied / Math.max(deploySeconds, 1)) * 600) / 10 : null, totalSeconds: steps.reduce((s, x) => s + x.seconds, 0) },
  steps,
}
fs.writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + '\n')
fs.copyFileSync(process.argv[2], `${require('node:path').dirname(process.argv[2])}/latest.json`)
const pad = (s, n) => String(s).padEnd(n)
console.error('\n==================== staging migration report ====================')
console.error(`verdict            ${evidence.verdict}${evidence.failedStep ? ` (failed at: ${evidence.failedStep})` : ''}`)
console.error(`commit             ${evidence.gitSha}${evidence.workingTreeDirty ? ' (dirty working tree)' : ''}`)
if (evidence.chain) console.error(`chain              ${evidence.chain.count} migrations, ${evidence.chain.first} .. ${evidence.chain.last}\n                   digest ${evidence.chain.digest}`)
if (evidence.before) console.error(`before             applied ${evidence.before.applied}, pending ${evidence.before.pending}${evidence.before.firstPending ? ` (${evidence.before.firstPending} .. ${evidence.before.lastPending})` : ''}`)
if (evidence.after) console.error(`after              applied ${evidence.after.applied}, pending ${evidence.after.pending}, applied this run ${evidence.after.appliedThisRun ?? 'n/a'}`)
if (deploySeconds !== null) console.error(`migrate deploy     ${deploySeconds}s${evidence.metrics.migrationsPerMinute ? `, ${evidence.metrics.migrationsPerMinute} migrations/min` : ''}`)
console.error('steps:'); for (const s of steps) console.error(`  ${pad(s.status, 8)} ${pad(s.seconds + 's', 6)} ${s.label}`)
console.error(`evidence           ${process.argv[2]}`)
console.error('==================================================================')
NODE
}

on_error() {
  local status=$?
  if [ "$FINISHED" = false ]; then FINISHED=true; write_evidence FAILED "$CURRENT_STEP" || true; fi
  exit "$status"
}
trap on_error ERR

# ---------- target guards (no network) ----------
CURRENT_STEP="target guards"
for tool in node pnpm psql git; do command -v "$tool" >/dev/null || { log "required tool not found: $tool"; false; }; done
[ -n "${MIGRATION_DATABASE_URL:-}" ] || { log "MIGRATION_DATABASE_URL (staging owner, direct endpoint) is required"; false; }
# The API login and the owner never share a variable here: the owner URL reaches only the commands that need it (with-migration-url.cjs, PROVISION_*).
unset DATABASE_URL

# url_parts <url>: host, port, database, user, password, sslmode, loopback(true|false), pooled(true|false), separated by US (0x1f) so an empty field
# (no password, no sslmode) cannot shift the others the way IFS whitespace would. Never echoed.
url_parts() {
  URL_IN="$1" node -e '
    const u = new URL(process.env.URL_IN); const host = u.hostname
    const out = [host, u.port || "5432", decodeURIComponent(u.pathname.replace(/^\//, "")), decodeURIComponent(u.username), decodeURIComponent(u.password),
      u.searchParams.get("sslmode") ?? "", String(["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)), String(/-pooler[.-]/.test(host))]
    if (out.some((v) => /[\x1f\n]/.test(v))) process.exit(3)
    process.stdout.write(out.join("\x1f") + "\n")'
}
IFS=$'\x1f' read -r OWNER_HOST OWNER_PORT TARGET_DATABASE OWNER_USER OWNER_PASSWORD OWNER_SSLMODE OWNER_LOOPBACK OWNER_POOLED < <(url_parts "$MIGRATION_DATABASE_URL") \
  || { log "MIGRATION_DATABASE_URL is not a valid postgresql:// URL"; false; }
TARGET_KIND=$([ "$OWNER_LOOPBACK" = true ] && echo local-rehearsal || echo remote)
[ -n "$TARGET_DATABASE" ] || { log "MIGRATION_DATABASE_URL names no database"; false; }
[ "$OWNER_POOLED" = false ] || { log "MIGRATION_DATABASE_URL is a pooled (-pooler) endpoint: migrations need the direct endpoint (Prisma's advisory lock does not survive PgBouncer transaction pooling)"; false; }
if [ "$OWNER_LOOPBACK" = false ]; then
  case "$OWNER_SSLMODE" in require|verify-ca|verify-full) ;; *) log "a remote target must use sslmode=require, verify-ca or verify-full"; false ;; esac
  [ -n "${PRODUCTION_DATABASE_HOSTS:-}" ] || { log "PRODUCTION_DATABASE_HOSTS is required for a remote target: name every production endpoint so this run can refuse it"; false; }
fi
IFS=',' read -r -a PROD_HOSTS <<< "${PRODUCTION_DATABASE_HOSTS:-}"
for prod in "${PROD_HOSTS[@]}"; do
  prod="$(echo "$prod" | tr -d '[:space:]')"
  # A Neon pooled host is the direct host plus "-pooler": compare both forms.
  if [ -n "$prod" ] && { [ "$OWNER_HOST" = "$prod" ] || [ "$OWNER_HOST" = "${prod/-pooler/}" ]; }; then
    log "MIGRATION_DATABASE_URL points at a production endpoint. This script only ever targets staging."; false
  fi
done
if [ "$REPROVISION" = true ] && [ -z "${API_RUNTIME_LOGIN_PASSWORD:-}" ]; then log "--reprovision-runtime-role needs API_RUNTIME_LOGIN_PASSWORD (a fresh staging-only secret)"; false; fi
if [ "$REPROVISION" = true ] && [ -z "${API_DATABASE_URL:-}" ]; then
  # Same endpoint and database as the owner URL, as the runtime login with the password just provisioned.
  API_DATABASE_URL="$(OWNER_URL="$MIGRATION_DATABASE_URL" PW="$API_RUNTIME_LOGIN_PASSWORD" LOGIN="${API_RUNTIME_LOGIN_ROLE:-fbeds_api_login}" node -e '
    const u = new URL(process.env.OWNER_URL); u.username = encodeURIComponent(process.env.LOGIN); u.password = encodeURIComponent(process.env.PW); process.stdout.write(u.toString())')"
  export API_DATABASE_URL
fi
if [ "$SKIP_RUNTIME_VERIFY" = false ] && [ "$DRY_RUN" = false ] && [ -z "${API_DATABASE_URL:-}" ]; then
  log "API_DATABASE_URL (staging runtime login) is required to verify least privilege; pass --reprovision-runtime-role or --skip-runtime-verify explicitly"; false
fi
if [ -n "${API_DATABASE_URL:-}" ]; then
  [ "$API_DATABASE_URL" != "$MIGRATION_DATABASE_URL" ] || { log "API_DATABASE_URL must not be the owner URL"; false; }
  IFS=$'\x1f' read -r API_HOST _ API_DB _ _ _ _ _ < <(url_parts "$API_DATABASE_URL") || { log "API_DATABASE_URL is not a valid URL"; false; }
  [ "$API_HOST" = "$OWNER_HOST" ] || [ "$API_HOST" = "${OWNER_HOST%%.*}-pooler.${OWNER_HOST#*.}" ] || { log "API_DATABASE_URL must point at the same staging endpoint as MIGRATION_DATABASE_URL"; false; }
  [ "$API_DB" = "$TARGET_DATABASE" ] || { log "API_DATABASE_URL must name the same database as MIGRATION_DATABASE_URL"; false; }
fi
REMOTE_FLAGS=(--allow-remote "--confirm-database=$TARGET_DATABASE")

cd "$ROOT"
GIT_SHA="$(git rev-parse HEAD)"
GIT_DIRTY=$([ -z "$(git status --porcelain --untracked-files=no)" ] && echo false || echo true)
if [ "$GIT_DIRTY" = true ] && [ "$ALLOW_DIRTY" = false ]; then log "the working tree has uncommitted changes: evidence must name the exact commit (commit, or pass --allow-dirty for a local rehearsal)"; false; fi
record "target guards" pass 0
log "target: database \"$TARGET_DATABASE\" ($TARGET_KIND), owner role \"$OWNER_USER\", commit ${GIT_SHA:0:12}"

# psql as the owner, credentials via the environment (never argv); fails fast instead of prompting.
owner_psql() {
  PGHOST="$OWNER_HOST" PGPORT="$OWNER_PORT" PGDATABASE="$TARGET_DATABASE" PGUSER="$OWNER_USER" PGPASSWORD="$OWNER_PASSWORD" \
  PGSSLMODE="${OWNER_SSLMODE:-prefer}" PGCONNECT_TIMEOUT=15 PGAPPNAME=fbeds-migrate-staging \
    psql -X -v ON_ERROR_STOP=1 -At "$@"
}
read_history() {
  owner_psql -c "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN '[]'::json ELSE (
    SELECT coalesce(json_agg(json_build_object('migration_name', migration_name, 'checksum', checksum, 'started_at', started_at, 'finished_at', finished_at,
      'rolled_back_at', rolled_back_at, 'applied_steps_count', applied_steps_count) ORDER BY started_at, id), '[]'::json) FROM public._prisma_migrations) END"
}
api_pnpm() { pnpm --silent --filter @bedbanks/api "$@"; }
owner_only() { api_pnpm exec node scripts/with-migration-url.cjs "$@"; }  # MIGRATION_DATABASE_URL -> DATABASE_URL for that one child only

# ---------- offline checks ----------
step "committed migration chain (IDs, order, SQL present)" node tools/migration-ledger-check.mjs chain
step "prisma validate" owner_only prisma validate --schema=prisma/schema.prisma

# ---------- connect (a suspended Neon compute wakes on the first connection) ----------
connect() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if owner_psql -c "SELECT 1" >/dev/null 2>&1; then
      owner_psql -F ' | ' -c "SELECT 'server ' || current_setting('server_version'), 'role ' || current_user,
        'superuser ' || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), 'bypassrls ' || (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
        'extensions available ' || (SELECT string_agg(name, ',' ORDER BY name) FROM pg_available_extensions WHERE name IN ('vector', 'pg_trgm'))"
      return 0
    fi
    log "connection attempt $attempt failed; retrying in $((attempt * 3))s"; sleep $((attempt * 3))
  done
  return 1
}
step "connect as owner" connect
extensions_available() {
  local n; n="$(owner_psql -c "SELECT count(*) FROM pg_available_extensions WHERE name IN ('vector', 'pg_trgm')")" || return 1
  [ "$n" = 2 ] || { echo "the server does not offer both vector and pg_trgm (migration 202610010003 creates them)"; return 1; }
}
step "required extensions available (vector, pg_trgm)" extensions_available

# ---------- history before ----------
history_before() {
  local args=(history --phase=before)
  [ -z "$EXPECT_PENDING" ] || args+=("--expect-pending=$EXPECT_PENDING")
  read_history | node tools/migration-ledger-check.mjs "${args[@]}" > "$WORK/history-before.json" || return 1
  node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).database; console.log(`applied ${h.applied}, pending ${h.pending}${h.pending ? ` (${h.firstPending} .. ${h.lastPending})` : ""}, resolved-without-execution ${h.resolvedWithoutExecution}, rolled-back rows ${h.rolledBackRows}`)' "$WORK/history-before.json"
}
step "history before: no unknown, failed, edited or out-of-order migrations${EXPECT_PENDING:+; exactly $EXPECT_PENDING pending}" history_before
PENDING="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).database.pending' "$WORK/history-before.json")"
# Prisma exits 1 while migrations are pending; that is the expected state here and is recorded, not fatal.
status_before() { owner_only prisma migrate status --schema=prisma/schema.prisma || [ "$PENDING" -gt 0 ]; }
step "prisma migrate status (before)" status_before

if [ "$DRY_RUN" = true ]; then
  log "dry run: $PENDING migration(s) would be applied; nothing was written"
  FINISHED=true; write_evidence DRY_RUN_NO_CHANGES; exit 0
fi

# ---------- deploy ----------
SINCE="$(owner_psql -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"  # the database clock, not the runner's
DEPLOY_START=$SECONDS
step "prisma migrate deploy ($PENDING pending, owner credential)" owner_only prisma migrate deploy --schema=prisma/schema.prisma
DEPLOY_SECONDS=$((SECONDS - DEPLOY_START))

# ---------- verification ----------
history_after() {
  read_history | node tools/migration-ledger-check.mjs history --phase=after "--since=$SINCE" "--expect-applied=$PENDING" > "$WORK/history-after.json" || return 1
  node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).database; console.log(`applied ${h.applied}, pending ${h.pending}, applied this run ${h.appliedThisRun}`)' "$WORK/history-after.json"
}
step "history after: nothing pending, $PENDING applied in chain order" history_after
step "prisma migrate status (after: must be up to date)" owner_only prisma migrate status --schema=prisma/schema.prisma
step "schema drift (migrated database vs prisma/schema.prisma)" owner_only node scripts/check-migration-drift.mjs

# The ops CLIs read the owner URL as PROVISION_DATABASE_URL and the runtime login as API_DATABASE_URL; each gets only the one it needs.
# shellcheck disable=SC2097,SC2098 # deliberate: the child gets the owner URL as PROVISION_DATABASE_URL and an empty MIGRATION_DATABASE_URL
as_provisioner() { PROVISION_DATABASE_URL="$MIGRATION_DATABASE_URL" MIGRATION_DATABASE_URL='' API_DATABASE_URL='' pnpm --silent --filter @bedbanks/api "$@" "${REMOTE_FLAGS[@]}"; }
as_runtime() { API_DATABASE_URL="$API_DATABASE_URL" MIGRATION_DATABASE_URL='' PROVISION_DATABASE_URL='' API_RUNTIME_LOGIN_PASSWORD='' pnpm --silent --filter @bedbanks/api "$@" "${REMOTE_FLAGS[@]}"; }
if [ "$REPROVISION" = true ]; then
  step "re-provision runtime role (REVOKE ALL, then exactly the contract; rotates the staging login password)" as_provisioner ops:provision-api-runtime-role
fi
group_exists() {
  [ "$(owner_psql -c "SELECT count(*) FROM pg_roles WHERE rolname = 'fbeds_api'")" = 1 ] \
    || { echo "runtime group role fbeds_api does not exist: provision it (--reprovision-runtime-role, docs/runbooks/api-runtime-role.md)"; return 1; }
}
step "runtime group role present" group_exists
step "ownership and forced RLS audit (owner view)" as_provisioner ops:strict-role-rollout audit
rollout_status() {
  local out; out="$(as_provisioner ops:strict-role-rollout status 2>&1)" || { echo "$out"; return 1; }
  echo "$out"
  grep -q '^Grant drift: none$' <<< "$out" || { echo "the runtime group's grants differ from the contract: re-run with --reprovision-runtime-role"; return 1; }
}
step "rollout status: no blockers, runtime grants exactly the contract" rollout_status
if [ "$SKIP_RUNTIME_VERIFY" = true ]; then
  record "runtime login verification (SKIPPED by --skip-runtime-verify)" skipped 0
  log "runtime login verification SKIPPED: this run cannot certify least privilege"
else
  step "runtime login verification (no superuser, no BYPASSRLS, owns nothing, probes)" as_runtime ops:strict-role-rollout verify
fi

FINISHED=true
if [ "$SKIP_RUNTIME_VERIFY" = true ]; then write_evidence MIGRATED_RUNTIME_ROLE_UNVERIFIED; else write_evidence STAGING_CERTIFIED; fi
