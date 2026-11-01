# ADR 0038: Unified hotel readiness for explicit criteria

## Status
Accepted for the API and Admin code. No schema, migration, grant, permission-catalogue or runtime-role change. ADR 0014 (one evaluator), ADR 0031 (commercial control failure) and ADR 0035 (markets and nationalities) are unchanged and are the rules this ADR composes.

## Context
Hotel readiness was shown in two incompatible shapes. The Hotel 360 gates (ADR 0014) judge a rolling window of nights with no buyer, so a green "READY" could be read as "sellable to anyone". The per-plan stay diagnostic added on this branch (`hotel-stay-readiness.ts`) judges one stay and one buyer but only per rate plan, and has no content gate. Neither answers the question an operator actually asks before enabling a hotel: "for this stay, this party, this nationality and this agency, which of content, mapping, contract, rate, inventory and distribution still blocks, and where do I fix it?"

## Decision
1. **One hotel-level assessment, explicit criteria.** `GET /admin/operations/hotels/:hotelId/readiness` takes check-in/out, rooms, adults, children with one age each, nationality, an optional agency and a currency. Every outcome applies to those criteria at the evaluation time and the response says so (`scope`, `limitations`, per-gate `criteriaApplied`).
2. **Seven separate gates**: CONTENT, MAPPING, CONTRACT, RATE, INVENTORY, DISTRIBUTION, SEARCH_RECHECK_EVIDENCE. Outcomes are `PASS | FAIL | UNKNOWN | NOT_APPLICABLE`. Each gate carries blockers with entity references, the criteria it applied, the evaluation time and a navigation action naming an existing workspace tab and the existing permission needed there.
3. **No second evaluator.** Per rate plan, `evaluateContractedStay` runs with the stated buyer on the snapshot from `buildStaySnapshot` (the Agent's own). Reasons are sorted into gates by a table derived from `SELLABILITY_GATES`, the table the inspector and the per-plan diagnostic already use; a reason that table does not list fails closed into CONTRACT. CONTENT is `assessCompleteness` (the twelve publication requirements, ADR 0021) passed in as data. Catalogue eligibility (profile COMPLETE, 1-5 stars) and agency suspension and restrictions are the conditions Agent search applies.
4. **A gate is judged across plans, the verdict is not.** A gate fails only when no candidate rate plan is clear of its reasons. The commercial verdict additionally requires that at least one plan passes every gate (`predictedOffers > 0`), so gates that pass on different plans cannot add up to "ready".
5. **UNKNOWN is a state, not a failure.** A privilege boundary on the profile or on agency restrictions gives UNKNOWN with the reason; it is never FAIL, zero or "unrestricted". Unknown agency controls also remove the predicted offers. Non-privilege infrastructure errors are not caught: they surface as the existing 5xx. Content publication is separate from sellability: a complete DRAFT passes CONTENT and fails DISTRIBUTION.
6. **Search and recheck evidence is UNKNOWN by construction.** Recheck outcomes are audited per offer id (`offer.recheck.*`, entity type `offer`) with no hotel reference, and nothing persists a per-hotel certification record. The predicted offer count is shown, labelled as the evaluator's prediction, and never promoted to evidence. Hosted Agent acceptance stays NOT_VERIFIED.
7. **Permissions reuse existing names.** The route needs `supply.rates.read` (enforced from formal role assignments by `SupplyPermissionGuard`). Naming an agency additionally needs the existing `agency.read`, through one shared check also used by the stay diagnostic. Tenant comes only from the session; another tenant's hotel or agency is a 404. Private contacts never leave the API.
8. **Read-only.** No hold, allocation, audit event or write. Reads that the runtime role may be denied run behind a SAVEPOINT (the repository pattern) and report UNKNOWN.
9. **Not modelled, stated in every response**: per-age child pricing and bed policy (child ages are validated and recorded; occupancy is head-count against the room limits and the plan occupancy), heterogeneous room parties, currency conversion (no FX policy exists; AED unless the deployment enables more).

## Alternatives rejected
- Extending the per-plan diagnostic only: it cannot express a hotel-level content gate or the single-plan rule, and the page would still need a roll-up.
- A stored readiness table or column: stale the moment a rate or availability row changes, and a schema change.
- Computing gates in the browser: duplicates commercial rules in React.
- Writing the hotel id into `offer.recheck.*` audit payloads to derive evidence: changes the Agent path, and the audit table is not readable by the runtime role, so the gate would still be UNKNOWN there.

## Consequences
- Operators get a criteria-scoped answer per gate with a place to fix it; the badge on Hotel 360 keeps its old, buyer-independent meaning and is labelled so.
- Two views remain on purpose: the per-plan stay diagnostic (inspector) and this hotel-level roll-up. Both classify reasons from `SELLABILITY_GATES`; changing that table changes both.
- Rollback: remove the `hotelReadiness` route, the `ReadinessPanel` component and `hotel-readiness.ts`. Nothing else depends on them.
