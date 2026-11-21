# ADR 0116: Finance posting must execute the ledger role predicate

Status: Accepted bug fix to the ADR 0076 / ADR 0113 role contracts.

The booking-transaction migration installs an invoker-rights `LedgerEntry` insert trigger. It calls `fbeds_is_booking_transaction_role()` for every writer before applying booking-only restrictions. PUBLIC cannot execute that predicate. The Finance posting role was therefore denied every real ledger append, although its zero-row privilege probes passed.

The owner-run Finance role provisioner now grants EXECUTE on that one boolean predicate, and its catalogue verifier requires the dependency. It grants no membership in the booking role, no new table privilege, and no ability to replace or bypass the trigger. Finance still cannot update or delete ledger entries, create bookings, read credentials or bypass tenant RLS. Trigger functions themselves remain outside this new grant.

Verification uses real Finance posting transactions (confirmation, cancellation, amendments, retries, idempotency and integrity), under the restricted login, plus the existing forbidden-operation probes. Zero-row probes alone cannot prove trigger dependencies.

Roll out the application and run the existing owner-operated Finance role provision/certification procedure on each intended environment. This change does not run that procedure against any persistent database. No migration is renamed, edited or added; existing migration-history reconciliation remains a separate launch gate.
