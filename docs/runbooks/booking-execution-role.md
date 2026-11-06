# Runbook: booking execution role (ADR 0113)

The login that completes an agent booking: hold, prebook, confirm, cancel, documents, and the ledger entries inside those transactions. `BOOKING_ENABLED` stays off until an owner turns it on for one environment. This role does not turn it on.

The login is `fbeds_booking_exec_ops`, member of the NOLOGIN group `fbeds_booking_exec`. It is not the database owner and it is not `fbeds_api`.

## Provision

1. Migrate with the owner credential. Never `prisma migrate dev` against a shared database.
2. Provision (owner credential, idempotent, prints no secret):

```
PROVISION_DATABASE_URL=<owner url> BOOKING_EXECUTION_LOGIN_PASSWORD=<32+ char URL-safe secret> \
  pnpm --filter @bedbanks/api ops:provision-booking-execution-role
```

A non-local target also needs `--allow-remote --confirm-database=<name>`.

3. Store `BOOKING_EXECUTION_DATABASE_URL` (that login and password, same host and database) in the secret manager. It must differ from `DATABASE_URL`. Do not put the owner URL in this variable.
4. Certify as the login itself:

```
BOOKING_EXECUTION_DATABASE_URL=<url> pnpm --filter @bedbanks/api ops:verify-booking-execution-role
```

Continue only on `Result: OK`.

5. Set `BOOKING_ENABLED` or `BOOKING_SERVICING_ENABLED` only after that certification, and only for the environment the owner named (ADR 0101). If either flag is true and this URL is missing, booking calls return `503` `BOOKING_EXECUTION_UNAVAILABLE`.

## What the login may change

Booking status and supplier fields, hold status, held and sold counters, a wallet row lock (`updated_at` only), an appended ledger entry, a cancellation refund, a supplier-mutation status, and an issued document. It cannot change a price, a credit limit, a cached balance, allotment, pool capacity, a ledger row, a credential, or an identity table, and it has no DELETE.
