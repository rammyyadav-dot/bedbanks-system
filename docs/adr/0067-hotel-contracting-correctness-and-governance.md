# ADR 0067: Hotel contracting correctness and governance (audit Phase 1)

Status: Accepted. Implemented finding by finding; each section names what is built and what is not.

## Context
A contracting audit of the admin hotel module (17 Oct 2026), measured against how global bedbanks and DMC wholesalers load direct hotel contracts, found that the sellability engine is sound but the contract itself had no governance and several contract rules were stored without effect. Phase 1 fixes correctness and governance: F-01, F-02, F-03, F-04, F-06, F-07 and F-17.

Constraints that apply throughout: tenant identity only from the session (1); a declared permission on every route (2); integer minor units (3); routes in `@bedbanks/contracts` first (4); audit events for privileged mutations (8); no placeholder presented as a capability (10); a reviewed forward migration with rollback notes, forced RLS and a tenant-index review for every new table.

## F-01: Contract maker-checker and versioning

**Problem.** Any holder of `supply.contracts.manage` could set a contract ACTIVE from a dropdown, and edit the supplier, currency, validity and markets of a live contract in place. `Contract.version` never moved. Rate plans, hotel publication and markups already required a second approver; the contract, the root commercial record, did not.

**Decision.**
- `status` is never written by `PATCH /supply/contracts/:id` (400 `CONTRACT_STATUS_VIA_LIFECYCLE_ONLY`), and `POST /supply/contracts` creates DRAFT only.
- Single-actor moves, each version-guarded by `expectedUpdatedAt` and audited as `supply.contract.status_changed` with from/to: DRAFT → REVIEW (`submit`), REVIEW → DRAFT (`return-to-draft`) and ACTIVE → SUSPENDED (`suspend`, reason required). Stopping sales is always allowed.
- Activation (DRAFT, REVIEW or SUSPENDED → ACTIVE) goes only through the existing maker-checker service with the new enforced, approval-only permission `contract.approve` (S3, refines `supply.contracts.manage`). The request is bound to the SHA-256 fingerprint of the canonical terms: the header and every cancellation, child and lead-time rule. A checker cannot approve if the terms moved after the request, and the execution re-checks the fingerprint and the activation readiness under a row lock (`SELECT … FOR UPDATE`). Readiness: an allowed status, validity that is ordered and not over, an active supplier, an approved hotel mapping when bound, a valid currency, and no rate plan the terms would break (currency, sale window, named cancellation set).
- While a contract is ACTIVE or EXPIRED its terms are locked: header edits, policy creation and the new policy deletions answer 409 `CONTRACT_TERMS_LOCKED`. Direct edits take the same row lock, so they serialize with an approval being applied.
- An ACTIVE contract changes only by an amendment: `POST /supply/contracts/:id/amendment-request` with the terms to change (code, validity, settlement currency, markets, nationalities, payment terms reference, and whole replacement sets of cancellation rules, child bands and the lead-time rule). The supplier and hotel binding identify a contract and are never amendable. The amendment is validated on filing and again on execution against the rate plans under the contract; it is applied in the same transaction that raises `version` by one.
- Every executed approval appends one `ContractVersion` row: version, kind (ACTIVATION or AMENDMENT), the terms as reviewed, the fingerprint, requester, approver, executor and reason. A reactivation raises the version only when the terms differ from the last snapshot. Rows are immutable: a trigger refuses UPDATE and DELETE for every role, and the contract foreign key is RESTRICT.
- `GET /supply/contracts/:id/lifecycle` returns status, version, fingerprint, whether terms are editable, the activation checklist, the open request with the caller's flags and the version history.
- Policy rules can now be deleted while the terms are editable. A delete that would empty a cancellation set still named by a refundable plan is refused.

**Admin.** The contract page drops the status dropdown and gains a lifecycle panel: status and version, checklist, submit / return / request activation / suspend, approve or reject for a second user, withdraw for the requester, apply once approved, and the version history. On an ACTIVE contract the form sends only the changed header terms as an amendment with a reason, and a staged policy editor files cancellation, child and lead-time changes as one amendment.

**Tests.** Unit: lifecycle transitions, fingerprint stability, activation checks, amendment validation and conflicts, version rule. End to end (`contract-approval.e2e-spec.ts`): DRAFT-only creation, PATCH refusal, single-actor transitions, binding and staleness, self-approval refusal, voiding by an edit and recovery, exactly-once execution under concurrency, locks on every term, amendment to version 2 with replaced policies and audit, suspension and reactivation to version 3, and immutability against the database owner. Suites that only need an ACTIVE contract seed it with `test/contract-status-fixture.ts`, like the existing rate-plan status fixture.

**Not built.** Automatic expiry of contracts after `validTo` (a contract stays ACTIVE and its nights stop selling by validity), contract termination (`contract.terminate` stays planned), and recording the contract version on each booking (bookings already freeze their cancellation terms).

**Rollback.** Revert the application change; drop the trigger, function, table and enum as listed in migration `202611200001_contract_versions`. Contracts keep their status and version.
