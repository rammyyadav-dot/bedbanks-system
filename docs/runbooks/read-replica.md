# Read replica for analytical reads (ADR 0074)

A Neon read replica is a read-only compute attached to the same branch and storage as the primary. It has its own endpoint host and the same roles, grants and row-level security. The API sends **reports** to it so they stop competing with booking and search traffic on the primary.

## What uses it

| Read | Connection |
| --- | --- |
| Hotel report (`GET /admin/operations/hotels/:id/report`) | `BOOKING_OPS_READ_REPLICA_URL` when set, otherwise `BOOKING_OPS_DATABASE_URL` |

Everything else, including every read that precedes a decision or must show the caller's own write (booking, hold, wallet, ledger, reconciliation workflow), stays on the primary. A replica can trail the primary by a short replication delay. Add a read to the replica only if a stale answer is acceptable.

## Deploy

1. **Create the read-only compute** on the production branch (console: Branch > Add compute > Read replica, or `neonctl branches add-compute <branch> --type read_only`). Choose a size for report load, not booking load. Enable autosuspend only if cold start latency (seconds) is acceptable for reports.
2. **Copy the endpoint host.** Build the URL from the booking login's URL, replacing only the host with the replica endpoint (use the pooled `-pooler` host if the primary URL uses one). Keep `sslmode=require` and set `connection_limit` explicitly (ADR 0067). No new role is created and no grant changes.
3. **Store it** as the `BOOKING_OPS_READ_REPLICA_URL` secret (same handling as `BOOKING_OPS_DATABASE_URL`). It must differ from `DATABASE_URL` and `BOOKING_OPS_DATABASE_URL`; an equal value counts as not configured.
4. **Redeploy the API.** On first use the replica connection verifies the login is a restricted role (not superuser, no BYPASSRLS, owns nothing), exactly like the primary.

## Connection budget

The API task now holds one more pool. Worst case is `tasks x sum(connection_limit)` across every role URL **plus this one**, against the compute's `max_connections` (the replica has its own limit; the primary is not charged for it). Record it per environment.

## Failure behaviour

- Not configured: reports run on the primary booking login.
- Configured and unusable (compute suspended and not resumable, refused, bad credential, role violation): the report answers `503 READ_REPLICA_UNAVAILABLE`. It does **not** retry on the primary, so a replica outage cannot move the reporting load back onto the primary. Retry later or remove the secret to return to the primary.
- Each replica transaction is `READ ONLY` with a 15 second statement timeout; a write or a runaway report is refused by PostgreSQL.

## Roll back

Remove `BOOKING_OPS_READ_REPLICA_URL` and redeploy. Nothing in the schema depends on it.

## Not verified here

Developed against PostgreSQL 16 with a restricted login. Not run against Neon: replication delay under load, autosuspend wake time, and the replica's `max_connections` need a check on a real branch before production.
