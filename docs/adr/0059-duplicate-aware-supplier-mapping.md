# ADR 0059: Supplier hotel mapping is refused when the supplier is already mapped to a likely duplicate

Status: Accepted and implemented on branch `claude/magical-ritchie-wnf0di`. Verified by API e2e (local Postgres 16, all migrations applied); the Admin panel step was driven in Chromium against the real stack (see Verification).

## Context
The costliest static-data failure in a bedbank is one physical property living under two canonical identities, each mapped to the same supplier: its rates and allotment are then sold twice, availability is double counted, and the duplicate is hard to unwind once bookings exist. ADR 0057 can already recognise a likely duplicate of a canonical hotel (similar name within 150 m, or similar name with the same postal code and city). Nothing used that at the moment a mapping goes live.

## Decision
- Approving a **hotel** mapping (`POST /supply/mappings/hotels/:id/approve`) now checks the canonical hotel for possible duplicates (`possibleDuplicatesFor`, shared with Hotel Setup). If the **same supplier** already has a mapping with status `MAPPED` to one of them, the approval is refused with 409 `MAPPING_LIKELY_DUPLICATE_CANONICAL`, and `error.details` lists each conflicting hotel (id, name, city, supplier hotel id, basis).
- The approver can proceed by sending `acknowledgeDuplicateHotelIds` naming **every** conflicting hotel **and** a `reason` (3 to 500 characters). Both are required; a partial list or a missing reason is refused again. The audit event records `acknowledgedDuplicateHotelIds` and the reason. Rejecting and reopening are never blocked.
- Only a supplier's `MAPPED` mappings count, and only the same supplier: two suppliers legitimately map the same hotel, and a duplicate that has only a PENDING mapping does not yet sell anything.
- Admin (Supplier Mapping tab): a refused approval shows the conflicting hotels with links and a confirmation checkbox, then "Verify anyway", which resends with the acknowledgement.
- Contract: `MAPPING_DUPLICATE_CONFLICT_CODE` and `HotelMappingApproveBody` in `@bedbanks/contracts`. No schema change, migration or permission: it uses `supply.mappings.manage`.
- Mapping creation and room mappings are unchanged. The scan is bounded (500 same-country peers), so on a very large tenant it is a strong hint, not proof.

## Not decided here
Merging duplicates, a duplicate review queue, cross-tenant or supplier-catalogue matching from supplier hotel names and coordinates (supplier mappings carry only ids today), and a maker-checker second approver for acknowledged duplicates.

## Rollback
Revert the commit; no data was migrated. Existing mappings are untouched.

## Verification
API e2e `hotel-setup.e2e-spec.ts` DM-01 (local Postgres 16): a duplicate pair with one MAPPED mapping is refused, a reasonless or partial acknowledgement is refused, a malformed list is a 400, the mapping stays PENDING, a full acknowledgement with a reason succeeds and is audited, and an unrelated hotel is not held up. `strict-runtime-role-hotel-setup` and `admin-golden-path` still pass. Browser: `tools/admin-ops-verify/verify-mapping-duplicates.cjs` (real API, production Admin build, Chromium) passes 5 of 5: the refusal names the duplicate, the mapping stays pending, "Verify anyway" is disabled until confirmed, the mapping is then verified and the acknowledgement and reason are audited. Not run: CI.
