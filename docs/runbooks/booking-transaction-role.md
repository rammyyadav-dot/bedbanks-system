# Booking transaction role

Agent booking mutations (hold, prebook, confirm, cancel, documents, reconciliation) run as `fbeds_booktx_ops`, not as `fbeds_api` and not as the database owner (ADR 0113). `BOOKING_ENABLED=true` does not grant those writes. Leave both unset until this runbook has been followed for that environment.

## Provision

From `apps/api`, against the owner credential, after `prisma migrate deploy` has applied `202612200001_booking_transaction_role_guards`:

```
PROVISION_DATABASE_URL=<owner URL> \
BOOKING_TRANSACTION_LOGIN_PASSWORD=<32+ URL-safe characters> \
pnpm ops:provision-booking-transaction-role
```

A non-local database also needs `--allow-remote --confirm-database=<name>`. The command prints the role and database names only.

Build `BOOKING_TRANSACTION_DATABASE_URL` from the same host and database with user `fbeds_booktx_ops` and that password. Store it in the secret manager. It must differ from `DATABASE_URL`. Do not set `PROVISION_DATABASE_URL` on the API service.

## Certify

```
BOOKING_TRANSACTION_DATABASE_URL=<the login URL> \
pnpm ops:verify-booking-transaction-role
```

Exit 0 means the catalogue check and the privilege probes passed. The probes use `WHERE false` and write nothing. Trigger behaviour (zero agency wallet allowed, house wallet and non-zero credit refused, booking ledger keys only) is certified by `apps/api/test/booking-transaction-role.e2e-spec.ts` on a disposable database.

## Enable

Only after the verify command passes, and only by an owner decision for that environment (ADR 0101): set `BOOKING_TRANSACTION_DATABASE_URL` on the API, then set `BOOKING_ENABLED=true`. If the URL is missing or equal to `DATABASE_URL`, the booking routes answer 503 `BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE` and do not call the services.

## Remove

Unset `BOOKING_TRANSACTION_DATABASE_URL` and `BOOKING_ENABLED`, then restart. To drop the login, run `deprovisionBooktxRole` from an owner session. The trigger rollback is the forward SQL in the migration header.
