#!/usr/bin/env bash
# Backup/restore drill against a DISPOSABLE local PostgreSQL (docs/runbooks/recovery.md "Restore drill").
#
#   SOURCE_URL=postgresql://postgres@localhost:5433/fbeds_ci tools/ops/restore-drill.sh
#
# Takes a custom-format dump of SOURCE_URL's database, restores it into a new "<db>_restore" database on the same
# server, and fails unless table row counts, forced-RLS tables, policies and the Prisma migration ledger match.
# It never writes to the source database and refuses non-loopback hosts: for RDS, restore a snapshot to a new
# instance (see recovery.md) and run `prisma:migrate:status`, `prisma:migrate:drift` and the tenant-control
# certification against it instead.
#
# Set KEEP_RESTORED=1 to keep "<db>_restore" for inspection (drop it before any role is dropped or re-provisioned).
#
# pg_dump of one database does not carry roles. Restore into a cluster where the runtime/ops roles already exist
# (or dump them with `pg_dumpall --globals-only`), otherwise grants are silently dropped by --no-owner restores.
set -euo pipefail

: "${SOURCE_URL:?SOURCE_URL is required (loopback PostgreSQL only)}"
workdir=${DRILL_DIR:-$(mktemp -d)}
src=${SOURCE_URL%%\?*}
host=$(sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#' <<<"$src")
case "$host" in localhost | 127.0.0.1 | ::1) ;; *) echo "refusing non-loopback host '$host'" >&2; exit 2 ;; esac
dbname=${src##*/}
target_name="${dbname}_restore"
admin=${src%/*}/postgres
target=${src%/*}/$target_name

psqlq() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }

fingerprint() {
  psqlq "$1" "
    WITH counts AS (
      SELECT c.relname AS t,
             (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I', c.relname), false, true, '')))[1]::text AS n
        FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace)
    SELECT concat_ws('|',
      (SELECT count(*) FROM counts),
      (SELECT md5(string_agg(t || ':' || n, ',' ORDER BY t)) FROM counts),
      (SELECT count(*) FROM pg_class WHERE relforcerowsecurity),
      (SELECT count(*) FROM pg_policy),
      (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL))"
}

now() { date +%s.%N; }

psqlq "$admin" "DROP DATABASE IF EXISTS \"$target_name\"" >/dev/null
t0=$(now)
pg_dump "$src" -Fc -f "$workdir/drill.dump"
t1=$(now)
psqlq "$admin" "CREATE DATABASE \"$target_name\"" >/dev/null
pg_restore -d "$target" --no-owner --exit-on-error "$workdir/drill.dump"
t2=$(now)

before=$(fingerprint "$src")
after=$(fingerprint "$target")
printf '{"drill":"logical-restore","source":"%s","dump_seconds":%.2f,"restore_seconds":%.2f,"dump_bytes":%s,"tables|digest|forced_rls|policies|migrations":"%s"}\n' \
  "$dbname" "$(bc <<<"$t1-$t0")" "$(bc <<<"$t2-$t1")" "$(stat -c %s "$workdir/drill.dump")" "$after"
if [ "$before" != "$after" ]; then
  echo "MISMATCH: source=$before restored=$after" >&2
  exit 1
fi
echo "PASS: restored database matches source (tables, row counts, forced RLS, policies, migration ledger)"
# A restored copy keeps grants to cluster-wide roles, which blocks later DROP ROLE of those roles; remove it unless asked to keep it.
[ -n "${KEEP_RESTORED:-}" ] || psqlq "$admin" "DROP DATABASE \"$target_name\"" >/dev/null
[ -n "${DRILL_DIR:-}" ] || rm -rf "$workdir"
