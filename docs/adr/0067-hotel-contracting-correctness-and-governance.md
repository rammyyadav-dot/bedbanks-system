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

## F-02: The contract booking lead time is enforced

**Problem.** A contract's lead-time rule (minimum hours before arrival, maximum days ahead) was saved, shown on the Policies and Contracts tabs and counted, but the stay evaluator never read it, so agents could book inside a cut-off the hotel contracted for.

**Decision.** `ContractedStaySnapshot.leadTimeRule` is a required field and `StayPlanInput.contract.leadTimeRules` must be loaded, so a loader that forgets it fails type-check (and `buildStaySnapshot` refuses at run time). `evaluateContractedStay` adds two reasons, both in the "Stay rules" gate:
- `LEAD_TIME_TOO_SHORT`: the booking is less than `minLeadHours` before the start of the check-in day in the hotel's zone. Midnight is the stricter reading; a later check-in hour never shortens the cut-off.
- `LEAD_TIME_TOO_LONG`: check-in is more than `maxLeadDays` hotel-local days after today.
An unusable hotel zone fails closed for whichever side is set. Because Agent search, recheck, hold, Admin readiness, the commercial assessment and rate certification all use this one evaluator, they all enforce it. The strict runtime role gains SELECT on `BookingLeadTimeRule` (and on `ChildPolicy`, for F-03); both tables keep their contract-joined RLS.

**Tests.** Unit: both bounds at the minute in Dubai time, no rule, and an invalid zone. End to end: Agent search hides the hotel while either rule blocks the stay and shows it again once the rule is removed.

## F-03: One child policy

**Problem.** A contract child policy (age band, extra bed, supplement) was stored and shown, but pricing read only the rate plan's own child lines. A dead `evaluateCommercialRules` function priced contract child bands and mandatory supplements but was never called. Children could therefore be refused, or sold on terms other than the contract's.

**Decision.**
- A rate plan's own CHILD lines govern it. A plan with no CHILD line inherits the contract's child bands (`effectiveGuestLines`). An inherited band is charged per child per night on the same basis (NET or SELL) as that night's rate, in the band's currency or the plan's when none is set. A band whose contract recorded no supplement cannot price a child who must be charged (`CHILD_PRICE_MISSING`): never priced as free.
- Children may fill base places that adults leave empty. The oldest children take those places at no extra charge, and only the remaining children are priced by band. So 1 adult + 1 child in a double pays the double rate, which is common practice. A party must still have at least one adult and fill the base occupancy.
- Agent search pre-selects a plan whose base occupancy is within the whole party when it has guest lines or its contract has child bands; the evaluator decides. The rate certification simulator uses the same effective lines, so its independent recomputation still agrees.
- `evaluateCommercialRules` and its types are removed. Compulsory supplements are designed in Phase 2.

**Admin.** The child band form now takes the supplement per child per night in the settlement currency (0 for free) and explains which plans it governs. The guest-price panel says whether its own lines or the contract policy apply.

**Tests.** Unit: inheritance, plan override, the INHERIT basis, the unpriced band, currency mismatch, and base places filled by the oldest child. End to end: Agent search prices an extra child aged 8 from the contract band, a child aged 3 free, 1 adult + 1 child at the double rate, and returns nothing for an age no band covers.

## F-06: One date convention: "valid to" is the last stay night

**Problem.** Agent search, recheck and hold read `Contract.validTo` and `RatePlan.validTo` as the last check-out date, while markups, promotions, rate and availability loading, the calendar import and the Sellability Inspector read the same field as the last night. Hotels write contract periods as stay nights (01 Nov – 31 Oct), so a contract keyed as written never sold its last night, yet the import accepted rates for it.

**Decision.** `validFrom` and `validTo` of contracts and rate plans are the first and last stay nights, inclusive, everywhere. The stay evaluator compares the stay's last night (check-out minus one day) with `validTo`. The Agent candidate query and the hold double-check bound `validTo` by the last night. Expiry, rate loading, import, markups and promotions already used this meaning. The admin labels now read "First stay night (valid from)" and "Last stay night (valid to)", and the rate plan's window "Last stay night on sale".

**Data.** Migration `202611200002_valid_to_is_last_night` moves every stored `validTo` back one day, so each contract and plan sells exactly the nights it sold before. It lifts forced RLS for its own transaction only, because the table owner would otherwise update no row. A row whose `validTo` equals `validFrom` sold nothing under the old meaning and is left unchanged; it now covers that one night. Operators can list such rows with `SELECT id, code FROM "Contract" WHERE valid_to = valid_from`. `ContractVersion` snapshots taken before the migration keep the reviewed value under the old meaning. The migration also changes the term fingerprint of every contract it touches, so any request open at release time can no longer be approved and must be filed again.

**Also fixed.** The hold double-check required a plan occupancy of at least the whole party, which contradicted guest-line pricing (ADR 0057 S6) and F-03. It now requires a base occupancy within the party, and the evaluator decides the rest.
