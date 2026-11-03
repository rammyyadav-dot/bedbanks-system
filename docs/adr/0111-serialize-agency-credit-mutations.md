# ADR 0111: Serialize agency credit changes with reservations

Status: accepted for implementation

## Context
Wallet authorizations already lock Wallet with SELECT FOR UPDATE and use the durable ledger balance. Holds use an agency advisory lock, but credit-limit execution did not participate. Wallet locking cannot serialize changes to a separate AgencyCreditLimit row. Locking that row alone cannot protect the prepaid case where it does not exist.

## Decision
Use the existing transaction advisory key `agency-credit:<agencyId>` for hold checks, financial authorization and approved limit execution. Acquire it before reading the balance/limit or checking the approval's before-state. PostgreSQL releases it on commit or rollback. All spending checks take the agency credit lock before the wallet row lock, matching inventory holds (ADR 0110). Authorization previews the tenant wallet to resolve the agency, then takes both locks and re-reads the wallet. Direct negative ledger posts take the same order. Limit execution takes only the agency lock. Agency identifiers are globally unique.

A reservation may precede a subsequent reduction below existing commitments, preserving established policy; later reservations see the new limit. Existing reservations are not revoked.

Retain Prisma. Existing withTenant transactions set transaction-local tenant context; migrations force RLS, and runtime identity checks reject owner, superuser and BYPASSRLS connections outside tests.

## Rollout and rollback
No schema migration or index change is required. Deploy all API replicas together: old replicas do not honor the expanded lock protocol. Reverting restores the prior concurrency gap. Production remediation requires deployment and PostgreSQL verification under the restricted runtime role.

## Verification
Regression tests pause lock acquisition to prove authorizations and first-time credit creation cannot read or write financial state before acquiring the lock. Existing PostgreSQL concurrency and RLS suites remain required for release certification.

The dedicated `test:credit:postgres` suite now exercises actual PostgreSQL 16 with a unique restricted financial login and forced RLS assertions. It covers agency and house-wallet contention, concurrent retries, reduction/rollback lock waits, hold-time credit checking, approved creation/change/removal, unfiltered tenant reads, rejected writes, and context cleanup on a reused connection. The tenant-isolation CI workflow provisions a disposable migrated database for it. This verifies code and migrations in isolation, not a production deployment or production financial grants.
