# fBeds Agent Portal hardening report

**Baseline:** `main` at `9fa568ce51968cd9c13c78e504da68f92515eb48` (PR #71 merged).  
**Branch:** `feat/agent-portal-transactional-foundation`  
**Date:** 2026-09-24  
**Decision:** Booking stays disabled. This branch is an incremental safety change and is not a certification for production booking.

## Capability register

| Capability | Classification | Evidence / next gate |
|---|---|---|
| Session authentication | REAL-NOW | Existing cookie based login, context and logout retained; full integration test pending. |
| Workspace selection | REAL-NOW | Existing server TenantContextGuard checks authenticated membership and active tenant on each request; frontend remounts on tenant switch. Suspended membership behavior and end to end isolation still need certification. |
| Finance summary | CORRECTLY-EMPTY-NOW | Existing endpoint retained; no fabricated balance; backend credit decision remains pending. |
| Live search | BLOCKED-PENDING-SUPPLIER | Search calls `/agent/search` with tenant header. Current backend returns only hotel, rate ID, roomName, board and totalMinor; populated results are deliberately blocked from the UI until canonical mappings are available. |
| Sample inventory | CORRECTLY-EMPTY-NOW | One demo dataset in the service, shown only when explicitly enabled outside production. Booking remains disabled. |
| Room/rate/board integrity | BLOCKED-PENDING-BACKEND | Current supplier port lacks independent roomTypeId, ratePlanId, boardBasisId, supplier offer reference, cancellation policy and price breakdown. Display strings cannot provide safe joins. |
| Rate recheck | BLOCKED-PENDING-SUPPLIER | Existing `/agent/rates/recheck` route now returns an honest unavailable response without invoking supplier recheck on an incomplete request. |
| Prebook and confirmed booking | BLOCKED-PENDING-CERTIFICATION | Existing API routes now return booking_unavailable without calling supplier prebook. Need supplier, transactional persistence, recheck and finance gates. |
| Booking review and voucher | BLOCKED-PENDING-BACKEND | No authoritative offer or confirmed booking exists from which to render them. |
| Booking history | CORRECTLY-EMPTY-NOW | Samples are visible only in explicit nonproduction demo mode; otherwise an unavailable state. |

## Changes and boundaries

- The public API base URL has one variable, `NEXT_PUBLIC_AGENT_API_URL`, shared by auth and search. `NEXT_PUBLIC_ENABLE_DEMO_INVENTORY` defaults to false. Production ignores the demo switch.
- The portal no longer owns a hotel inventory array. The search service owns sample inventory and returns typed demo, empty, unavailable, mapping, authentication or access states. Network and HTTP failures cannot become demo offers.
- The backend still does **not** return a complete canonical room/rate/meal plan contract. The UI does not convert incomplete supplier payloads into bookable offers or calculate an authoritative total.
- The API keeps tenant and RBAC guards on search, recheck, prebook and booking routes. It derives authorization from authenticated membership; the header requests a tenant context. No migration was made.
- The sample room/card remains presentation only. Its amount is illustrative and cannot authorize a booking. Search occupancy is fixed at one room and two adults until a validated request form is built.
- The existing monolithic component is still broad; domain component decomposition, review UI, booking events and operational instrumentation remain work.

## Verification

- `node --test apps/agent/services/hotel-service.test.mjs`: **4 passed** (explicit demo, production failure, incomplete mapping, authorization denial).
- `pnpm --filter @bedbanks/agent-portal type-check`, `lint`, `build`: attempted in a partial connector checkout; pnpm printed `No projects found`. These are **not passes**.
- Full API/domain tests, auth and tenant integration tests, and Next build are **not run** in this environment. CI must execute these on the complete repository.
- The baseline did not have a local clone or installed dependencies, so baseline checks were also **not verified**. Node v24.19.0 and local pnpm 11.19.0 were observed; repo CI pins its own toolchain.

## Release gates

1. Run pnpm install and Agent type-check, lint, test and build on the complete repository; run API/domain tests and inspect CI.
2. Add canonical independently keyed hotel, room, rate plan, board basis, supplier offer and integer minor unit price contracts in the shared domain, with runtime validation.
3. Implement genuine supplier recheck using an authenticated tenant, search context, offer token, expiration and authoritative total; test unchanged, changed, expired and unavailable rates.
4. Implement a backend authoritative credit decision and transactional booking persistence with idempotency and confirmation/voucher chain; certify migrations before any schema change.
5. Finish UI component decomposition, validated occupancy and date controls, review flow, auth/tenancy integration tests, and safe observability.
