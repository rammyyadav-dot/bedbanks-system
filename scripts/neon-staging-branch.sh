#!/usr/bin/env bash
# Neon branch governance for the staging migration pipeline (ADR 0075, docs/runbooks/neon-staging-migrations.md).
#
#   scripts/neon-staging-branch.sh create        [--name staging] [--parent main] [--reset] [--keep-inherited-passwords]
#   scripts/neon-staging-branch.sh env           --env-file PATH [--name staging] [--production main]
#   scripts/neon-staging-branch.sh protect       [--production main] [--retention-days 7] [--allowed-ips CIDR[,CIDR...]]
#   scripts/neon-staging-branch.sh restore-point [--production main] [--label <git sha or ticket>]
#   scripts/neon-staging-branch.sh status        [--name staging] [--production main]
#   scripts/neon-staging-branch.sh replica-create [--production main] [--min-cu 0.25] [--max-cu 1]
#   scripts/neon-staging-branch.sh replica-status [--production main]
#
# Environment: NEON_API_KEY, NEON_PROJECT_ID (required); NEON_DATABASE (default neondb); NEON_OWNER_ROLE (default neondb_owner, the role that owns the
# schema and runs migrations); NEONCTL (default: npx --yes neonctl@8.8.0, pinned).
#
# create         Branch `staging` from the production branch's current head (copy-on-write: production data and schema, no load on production). With
#                --reset an existing staging branch is reset to its parent's head instead, the previous state kept as staging-before-<UTC time>. The owner
#                role's password on staging is then rotated (a child of an unprotected branch inherits production passwords), unless
#                --keep-inherited-passwords.
# env            Writes MIGRATION_DATABASE_URL (staging owner, direct endpoint) and PRODUCTION_DATABASE_HOSTS (every production endpoint, direct and pooled)
#                to an 0600 env file for scripts/migrate-staging.sh. Masks both in GitHub Actions. Refuses to emit credentials for a protected or default
#                branch: this script never hands out production credentials.
# protect        Marks the production branch protected (no delete, reset or archive; children get new passwords; IP allowlist can be scoped to it), sets
#                the point-in-time restore window, optionally applies an IP allowlist to protected branches only. Idempotent.
# restore-point  Before a production migration: creates a compute-less branch at production's current head (an instant, named restore point) and
#                prints the exact point-in-time restore command for that moment.
# status         Branches (name, default, protected, parent), the PITR window and the staging endpoint kind. No secrets.
#
# replica-create Adds a read-only compute (read replica) to the production branch. Neon replicas share the primary's storage: they scale reads and
#                survive a primary compute restart, but they are NOT a disaster-recovery copy (restore points and the PITR window are). Idempotent: an
#                existing read-only endpoint is reported, not duplicated. Provisions the endpoint only; no application reads from it until the API gains an
#                explicit, reviewed read path (ADR 0079). Prints endpoint ids and states, never hosts' credentials.
# replica-status Lists the production branch's endpoints (id, type, state, autoscaling range, pooler). No secrets.
#
# Never prints a connection string or password. Requires curl, node and (through npx) neonctl.
set -Eeuo pipefail

NEON_API="${NEON_API_URL:-https://console.neon.tech/api/v2}"
NEON_DATABASE="${NEON_DATABASE:-neondb}"
NEON_OWNER_ROLE="${NEON_OWNER_ROLE:-neondb_owner}"
read -r -a NEONCTL_CMD <<< "${NEONCTL:-npx --yes neonctl@8.8.0}"

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
log() { printf '[neon] %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

COMMAND="${1:-}"; [ -n "$COMMAND" ] || usage; shift
NAME=staging; PARENT=main; PRODUCTION=main; RESET=false; KEEP_PASSWORDS=false; ENV_FILE=""; RETENTION_DAYS=7; ALLOWED_IPS=""; LABEL=""; MIN_CU=0.25; MAX_CU=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?}"; shift 2 ;;
    --parent) PARENT="${2:?}"; shift 2 ;;
    --production) PRODUCTION="${2:?}"; shift 2 ;;
    --reset) RESET=true; shift ;;
    --keep-inherited-passwords) KEEP_PASSWORDS=true; shift ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --retention-days) RETENTION_DAYS="${2:?}"; shift 2 ;;
    --allowed-ips) ALLOWED_IPS="${2:?}"; shift 2 ;;
    --label) LABEL="${2:?}"; shift 2 ;;
    --min-cu) MIN_CU="${2:?}"; shift 2 ;;
    --max-cu) MAX_CU="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "${NEON_API_KEY:-}" ] || die "NEON_API_KEY is required (store it only in the reviewed GitHub environment or an operator shell)"
[ -n "${NEON_PROJECT_ID:-}" ] || die "NEON_PROJECT_ID is required"
for tool in curl node; do command -v "$tool" >/dev/null || die "required tool not found: $tool"; done
case "$NAME" in main|master|production|prod) die "--name $NAME looks like production; the staging branch must have its own name" ;; esac
[ "$NAME" != "$PRODUCTION" ] || die "--name and --production must differ"

neonctl() { "${NEONCTL_CMD[@]}" --project-id "$NEON_PROJECT_ID" "$@"; }

# neon_api <METHOD> <path> [json body]: the REST API for what neonctl 8.8.0 cannot do (protect an existing branch, retention, password reset).
neon_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS --fail-with-body --retry 3 -X "$method" -H "Authorization: Bearer $NEON_API_KEY" -H 'Accept: application/json')
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data "$body")
  curl "${args[@]}" "$NEON_API$path"
}
# json <expression over `d`> < json: evaluates a JS expression against stdin; prints strings bare and everything else as JSON.
json() { node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); const v = eval(process.argv[1]); process.stdout.write(v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v))' "$1"; }

# Waits for every operation a REST call started (Neon rejects most changes while one is running on the branch).
wait_operations() {
  local response="$1" id status
  for id in $(json '(d.operations ?? []).map((o) => o.id).join(" ")' <<< "$response"); do
    for _ in $(seq 1 60); do
      status="$(neon_api GET "/projects/$NEON_PROJECT_ID/operations/$id" | json 'd.operation.status')"
      case "$status" in finished|skipped) break ;; failed|error|cancelled) die "Neon operation $id ended $status" ;; esac
      sleep 2
    done
    case "$status" in finished|skipped) ;; *) die "Neon operation $id did not finish in time (last status: $status)" ;; esac
  done
}

branches_json() { neon_api GET "/projects/$NEON_PROJECT_ID/branches"; }
branch_field() { branches_json | json "(d.branches.find((b) => b.name === process.env.BRANCH) ?? {})[process.env.FIELD]" ; }
branch_id() { BRANCH="$1" FIELD=id branch_field; }
require_branch() { local id; id="$(branch_id "$1")"; [ -n "$id" ] || die "branch \"$1\" not found in project"; printf '%s' "$id"; }

# A branch this script may hand credentials for: exists, is not the default branch, is not protected, and is not the production branch.
assert_non_production() {
  local name="$1" info
  info="$(branches_json | BRANCH="$name" json 'd.branches.find((b) => b.name === process.env.BRANCH) ?? null')"
  [ -n "$info" ] || die "branch \"$name\" not found"
  [ "$(json 'String(Boolean(d.default || d.primary))' <<< "$info")" = false ] || die "branch \"$name\" is the project's default branch: refusing"
  [ "$(json 'String(Boolean(d.protected))' <<< "$info")" = false ] || die "branch \"$name\" is protected: refusing to issue its credentials"
  [ "$name" != "$PRODUCTION" ] || die "branch \"$name\" is the production branch: refusing"
}

rotate_owner_password() {
  local id="$1"
  log "rotating the \"$NEON_OWNER_ROLE\" password on \"$NAME\" (it no longer matches production)"
  wait_operations "$(neon_api POST "/projects/$NEON_PROJECT_ID/branches/$id/roles/$NEON_OWNER_ROLE/reset_password")"
}

cmd_create() {
  local parent_id staging_id
  parent_id="$(require_branch "$PARENT")"
  staging_id="$(branch_id "$NAME")"
  if [ -n "$staging_id" ]; then
    assert_non_production "$NAME"
    [ "$RESET" = true ] || die "branch \"$NAME\" already exists; pass --reset to reset it to the head of \"$PARENT\" (its current state is preserved under a new name)"
    [ "$(BRANCH="$NAME" FIELD=parent_id branch_field)" = "$parent_id" ] || die "branch \"$NAME\" is not a child of \"$PARENT\"; refusing to reset it"
    local preserved
    preserved="$NAME-before-$(date -u +%Y%m%dT%H%M%SZ)"
    log "resetting \"$NAME\" to the head of \"$PARENT\"; previous state kept as \"$preserved\""
    neonctl branches reset "$NAME" --parent --preserve-under-name "$preserved" -o json > /dev/null
  else
    log "creating \"$NAME\" from the head of \"$PARENT\" (copy-on-write; read-write compute)"
    neonctl branches create --name "$NAME" --parent "$PARENT" --type read_write --no-secrets -o json > /dev/null
    staging_id="$(require_branch "$NAME")"
  fi
  assert_non_production "$NAME"
  [ "$KEEP_PASSWORDS" = true ] || rotate_owner_password "$staging_id"
  log "staging branch ready: $NAME ($staging_id), parent $PARENT ($parent_id)"
}

cmd_env() {
  [ -n "$ENV_FILE" ] || die "env needs --env-file PATH"
  assert_non_production "$NAME"
  local uri prod_id hosts
  uri="$(neonctl connection-string "$NAME" --role-name "$NEON_OWNER_ROLE" --database-name "$NEON_DATABASE" --ssl require)"
  case "$uri" in postgres://*|postgresql://*) ;; *) die "neonctl did not return a connection string for \"$NAME\"" ;; esac
  prod_id="$(require_branch "$PRODUCTION")"
  hosts="$(neon_api GET "/projects/$NEON_PROJECT_ID/branches/$prod_id/endpoints" \
    | json 'd.endpoints.flatMap((e) => [e.host, e.host.replace(/^([^.]+)\./, "$1-pooler.")]).join(",")')"
  [ -n "$hosts" ] || die "production branch \"$PRODUCTION\" has no endpoints to deny"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::add-mask::$uri"
    echo "::add-mask::$(URI="$uri" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.URI).password))')"
  fi
  ( umask 077; { printf 'MIGRATION_DATABASE_URL=%s\n' "$uri"; printf 'PRODUCTION_DATABASE_HOSTS=%s\n' "$hosts"; } > "$ENV_FILE" )
  log "wrote MIGRATION_DATABASE_URL (\"$NAME\" owner, direct endpoint) and PRODUCTION_DATABASE_HOSTS ($(tr ',' '\n' <<< "$hosts" | wc -l | tr -d ' ') hosts) to $ENV_FILE"
}

cmd_protect() {
  [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -ge 1 ] && [ "$RETENTION_DAYS" -le 30 ] || die "--retention-days must be 1..30 (the plan's maximum applies)"
  local prod_id; prod_id="$(require_branch "$PRODUCTION")"
  [ "$(BRANCH="$PRODUCTION" FIELD=default branch_field)" = true ] || log "warning: \"$PRODUCTION\" is not the project's default branch"
  log "protecting \"$PRODUCTION\" (no delete/reset/archive; child branches get new passwords)"
  wait_operations "$(neon_api PATCH "/projects/$NEON_PROJECT_ID/branches/$prod_id" '{"branch":{"protected":true}}')"
  local body
  body="$(SECONDS_="$((RETENTION_DAYS * 86400))" IPS="$ALLOWED_IPS" node -e '
    const project = { history_retention_seconds: Number(process.env.SECONDS_) }
    const ips = process.env.IPS.split(",").map((s) => s.trim()).filter(Boolean)
    if (ips.length) project.settings = { allowed_ips: { ips, protected_branches_only: true } }
    process.stdout.write(JSON.stringify({ project }))')"
  log "setting the point-in-time restore window to ${RETENTION_DAYS} day(s)${ALLOWED_IPS:+ and the protected-branch IP allowlist}"
  wait_operations "$(neon_api PATCH "/projects/$NEON_PROJECT_ID" "$body")"
  cmd_status
}

cmd_restore_point() {
  local prod_id at name
  prod_id="$(require_branch "$PRODUCTION")"
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  name="restore-point-$(date -u +%Y%m%dT%H%M%SZ)${LABEL:+-$(tr -c 'a-zA-Z0-9-' '-' <<< "$LABEL" | cut -c1-20 | sed 's/-*$//')}"
  log "creating compute-less restore point \"$name\" at the head of \"$PRODUCTION\" ($at)"
  neonctl branches create --name "$name" --parent "$PRODUCTION" --no-compute --no-secrets -o json > /dev/null
  cat <<EOF
Restore point created: $name (production head at $at, branch id of production: $prod_id).
If the production migration must be undone, restore production to this moment (the current state is preserved under the given name):
  ${NEONCTL_CMD[*]} --project-id <project> branches restore $PRODUCTION ^self@$at --preserve-under-name $PRODUCTION-before-restore-<UTC time>
or to the restore-point branch itself:
  ${NEONCTL_CMD[*]} --project-id <project> branches restore $PRODUCTION $name --preserve-under-name $PRODUCTION-before-restore-<UTC time>
Point-in-time restore is bounded by the history retention window (see: status). Delete the restore-point branch once the release is accepted.
EOF
}

cmd_status() {
  local project
  project="$(neon_api GET "/projects/$NEON_PROJECT_ID")"
  branches_json | PROD="$PRODUCTION" STG="$NAME" RET="$(json 'd.project.history_retention_seconds' <<< "$project")" json '
    (() => {
      const byId = new Map(d.branches.map((b) => [b.id, b.name]))
      const rows = d.branches.map((b) => `  ${b.name.padEnd(36)} default=${Boolean(b.default || b.primary)} protected=${Boolean(b.protected)} parent=${byId.get(b.parent_id) ?? "-"}`)
      const days = Number(process.env.RET) / 86400
      const prod = d.branches.find((b) => b.name === process.env.PROD)
      return [`branches:`, ...rows, `point-in-time restore window: ${days} day(s)`,
        `production "${process.env.PROD}": ${prod ? (prod.protected ? "protected" : "NOT PROTECTED (run: protect)") : "missing"}`, ""].join("\n")
    })()'
}

cmd_replica_status() {
  local prod_id; prod_id="$(require_branch "$PRODUCTION")"
  neon_api GET "/projects/$NEON_PROJECT_ID/branches/$prod_id/endpoints" | PROD="$PRODUCTION" json '
    (() => {
      const rows = d.endpoints.map((e) => `  ${e.id.padEnd(28)} type=${e.type} state=${e.current_state} cu=${e.autoscaling_limit_min_cu}-${e.autoscaling_limit_max_cu} pooler=${Boolean(e.pooler_enabled)}`)
      const replicas = d.endpoints.filter((e) => e.type === "read_only").length
      return [`endpoints on "${process.env.PROD}":`, ...rows, `read replicas: ${replicas}`, ""].join("\n")
    })()'
}

cmd_replica_create() {
  [[ "$MIN_CU" =~ ^[0-9]+(\.[0-9]+)?$ && "$MAX_CU" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--min-cu and --max-cu must be numbers (compute units)"
  node -e 'process.exit(Number(process.argv[1]) <= Number(process.argv[2]) && Number(process.argv[1]) > 0 ? 0 : 1)' "$MIN_CU" "$MAX_CU" || die "--min-cu must be > 0 and <= --max-cu"
  local prod_id existing body
  prod_id="$(require_branch "$PRODUCTION")"
  existing="$(neon_api GET "/projects/$NEON_PROJECT_ID/branches/$prod_id/endpoints" | json 'd.endpoints.filter((e) => e.type === "read_only").map((e) => e.id).join(" ")')"
  if [ -n "$existing" ]; then
    log "\"$PRODUCTION\" already has a read replica ($existing); nothing created"
    cmd_replica_status
    return
  fi
  body="$(BRANCH_ID="$prod_id" MIN="$MIN_CU" MAX="$MAX_CU" node -e '
    process.stdout.write(JSON.stringify({ endpoint: { branch_id: process.env.BRANCH_ID, type: "read_only", autoscaling_limit_min_cu: Number(process.env.MIN), autoscaling_limit_max_cu: Number(process.env.MAX) } }))')"
  log "adding a read-only compute to \"$PRODUCTION\" (${MIN_CU}-${MAX_CU} CU); production's data and primary compute are untouched"
  wait_operations "$(neon_api POST "/projects/$NEON_PROJECT_ID/endpoints" "$body")"
  cmd_replica_status
}

case "$COMMAND" in
  replica-create) cmd_replica_create ;;
  replica-status) cmd_replica_status ;;
  create) cmd_create ;;
  env) cmd_env ;;
  protect) cmd_protect ;;
  restore-point) cmd_restore_point ;;
  status) cmd_status ;;
  *) usage ;;
esac
