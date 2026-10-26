# Runbook: provision the commission payout scheduler background role

Closes the operational half of ADR 0098's scheduler update. Executed by the
**database owner**, not by CI or an AI session. Nothing here touches
production until a human runs it.

Unlike the hold-expiry role (`docs/runbooks/hold-expiry-role.md`), there is
**no provisioning CLI or GitHub Actions workflow for this role yet** — that
is a deliberate, labeled gap (see ADR 0098's "Not done" section), not an
oversight. The steps below are the manual equivalent; a follow-up can lift
them into `ops:provision-commission-scheduler-role` and a workflow the same
shape as "Provision hold-expiry role" without changing anything here.

## 0. Preconditions

- The migration `202612130001_commission_scheduler_system_audit` is deployed
  (`prisma migrate deploy` through the normal, approved release process).
- A verified backup / restore point exists.
- The owner has approved the change and a change window.

## 1. Generate the credential

Generate a 32+ character URL-safe secret in your secret manager
(`openssl rand -base64 30 | tr '+/' '-_' | tr -d '='`). Do not paste it in
chat, tickets or logs.

## 2. Provision (owner credential, manual SQL)

Connect as the database owner and run:

```sql
CREATE ROLE fbeds_commission_scheduler NOLOGIN;
CREATE ROLE fbeds_commission_scheduler_login LOGIN PASSWORD '<secret from step 1>'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
GRANT fbeds_commission_scheduler TO fbeds_commission_scheduler_login;

GRANT SELECT ("id", "status") ON "tenants" TO fbeds_commission_scheduler_login;
GRANT SELECT ("id", "status") ON "Agency" TO fbeds_commission_scheduler_login;
GRANT SELECT ("id", "tenant_id", "agency_id", "currency") ON "Wallet" TO fbeds_commission_scheduler_login;
GRANT SELECT ON "BookingFinancePosting" TO fbeds_commission_scheduler_login;
GRANT SELECT, INSERT ON "AgencyCommissionPayout" TO fbeds_commission_scheduler_login;
GRANT SELECT, INSERT ON "AuditEvent" TO fbeds_commission_scheduler_login; -- INSERT is further limited by the migration's RLS policy to the one SYSTEM proposal action
GRANT USAGE ON SCHEMA public TO fbeds_commission_scheduler_login;
```

No privilege beyond this list is required or should be granted: in
particular this role must never see `Booking`, `LedgerEntry`, `User`,
session or credential tables, and the `AuditEvent` policy from the migration
already stops it from inserting anything but the one SYSTEM proposal event
in its own tenant context.

## 3. Store the runtime setting

Build `COMMISSION_SCHEDULER_DATABASE_URL` from the same host and database
with the login role and secret, and store it as a **secret reference** in
the API runtime environment. It must differ from `DATABASE_URL`. Do not
commit it.

## 4. Verify before enabling

Connect as the login role and confirm `PrismaService.assertRestrictedRuntimeRole`
passes (not superuser, no BYPASSRLS, owns nothing, not the migration owner —
the same generic check every other runtime role passes, ADR 0040). Confirm by
hand that an INSERT into `AuditEvent` with `actor_type = 'SYSTEM'` and any
`action` other than `finance.commission_payout.proposed`, or any `entity_type`
other than `agency_commission_payout`, is rejected by RLS.

## 5. Enable

Set `COMMISSION_PAYOUT_SCHEDULER_ENABLED=true` and `COMMISSION_PAYOUTS_ENABLED=true`
(the scheduler proposes into the same feature; it does not bypass the flag that
gates the HTTP service's writes) and restart the API. It fails fast if the
credential is missing or equals `DATABASE_URL`, or if the booking finance
posting module is not loaded. Watch for `Commission payout scheduling pass:`
and `Commission payout scheduling failed` log lines for the first run (default
every 6 hours; `COMMISSION_PAYOUT_SCHEDULER_INTERVAL_MS` to change it, minimum
60000).

## Rollback

1. `COMMISSION_PAYOUT_SCHEDULER_ENABLED=false`, restart.
2. Revoke: `DROP OWNED BY fbeds_commission_scheduler_login; DROP ROLE fbeds_commission_scheduler_login; DROP ROLE fbeds_commission_scheduler;`
3. Policy rollback SQL is in the migration header (forward migration, reviewed first).
