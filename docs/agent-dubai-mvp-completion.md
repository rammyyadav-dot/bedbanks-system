# Agent portal: Dubai contracted-inventory search and recheck MVP (completion record)

Scope: Login, Search, Hotel results, Hotel details, Room/board/rate offer, Offer selection, Authoritative recheck, and the four outcomes (Rechecked, Price changed, Unavailable, Expired). Booking, payment, live suppliers, production deployment, persistent database changes and alias changes are out of scope and were not touched. fBeds is kept separate from UAEWB. F01 stays OPEN; its pinned candidate `aea042299bdc2b7fbc33945b0cb89ba0a7a04238` is unchanged.

## Base and head
| | |
| --- | --- |
| Base | `origin/main` `9a05688203511e5b0ce1764d9384662ab7fa3674`, tree `09e2d2b53d2d2ae056c56858ee88e910b065dc65` (working tree clean when branched) |
| Branch | `feat/agent-dubai-mvp-completion` |
| Code head tested | `7fe53503dead1f6f804c590645b22377a4cc9486` (the last commit that changes code). The evidence and this record are added in a docs-only commit after it; no code changed after the tested head. |
| Tools | Node v24.21.0, pnpm 10.4.1, PostgreSQL 16 (disposable local cluster), Chromium via Playwright |

## Inspection result
The Agent portal was already substantially built: canonical destination resolution (typed text is not a destination), per-room occupancy with child ages, server pagination with generation guards against out-of-order responses, canonical offer ids, an automatic authoritative recheck on selection with explicit price acceptance, fail-closed hosted API URL validation, and a server-controlled `bookingEnabled` flag. It was not rebuilt. The work was an acceptance harness on the real stack plus fixes for the gaps it exposed.

## Gap matrix
| Requirement | Existing implementation | Evidence | Gap | Change |
| --- | --- | --- | --- | --- |
| Session expiry recovery | Gate shows an expired notice only when the first context probe says so | L1 (before): after the session was revoked mid-journey a search attempt showed no way back | In-session 401 left the agent on a stale page | `session-events`: any 401 outside login/context announces expiry; the auth gate clears account state and returns to sign-in with the notice |
| "Showing N of total" | Window from server offset and total | C2 (before): "Showing 26–36 of 36" with 36 cards after "Load more" | Window start followed the newest page | Load more keeps the first window start and the server total; numbered page links are hidden once pages are accumulated |
| Expiry display | Raw ISO string in the review panel | E2 (before) | Not readable, no hotel time zone | `formatOfferExpiry` (hotel time zone, rejects non-instants) used for the rechecked offer |
| Booking-disabled endpoint | "Booking review" panel after a recheck, even with booking disabled | E3 (before) | Implied the start of a booking | With booking disabled the panel is "Rechecked offer" with the authoritative price, valid-until time and a note that no hold, booking or payment is created. Booking UI stays driven by the server flag only |
| One main landmark | Workspace `<main>` wrapped the portal `<main>` | O5 (before): 2 | Duplicate landmark | Workspace renders a `<div>` while the marketplace is active |
| Contrast (WCAG AA) | Several teal/gray text colours | O6, O7 (before): color-contrast | Below 4.5:1 | Darkened link, kicker, label, muted and note colours |
| Tablet overflow | Shell negative margin 24px, container padding 16px | O1 at 768px (before): 8px | Horizontal scroll | Margin aligned with the padding |
| Role without finance access | "Not configured" credit label | Console 403 on finance summary | Misleading | "Not available to your role" when the finance call is denied |
| Testability of distinct offers | React key only | D4 (before) | No stable DOM identity | `data-offer-id` carries the canonical offer id |

## Final conformance
Real-stack acceptance: production Agent build (same-origin proxy, server-only `API_INTERNAL_URL`) to the real Nest API connected as the provisioned non-superuser, non-BYPASSRLS, non-owner login `fbeds_api_login`, to disposable PostgreSQL with contracted-inventory fixtures. A second API process with `AGENT_OFFER_TTL_MS=1500` is used only for the real server-side expiry check. Checks marked [injected] use browser route interception (controlled failure injection); every other check is database-backed. Result: **50/50** (`docs/evidence/agent-dubai-mvp/browser-journey.log`).

| Journey step | Checks | Notes |
| --- | --- | --- |
| A Login/session | A1–A5 | fresh visit not reported as expired; wrong password refused; hostile `next`/`returnTo` ignored (only an allow-list of local paths is accepted by `safeReturnPath`); session cookie HttpOnly, nothing secret in script-visible storage; tenant from authenticated context, `bookingEnabled=false` |
| B/C Search, pagination | B1, B2, C1–C4 | 36 hotels, "Showing 1–25 of 36", load more reaches 36 unique, "Showing 1–36 of 36"; stale-supplier, CLOSED and other-tenant hotels absent |
| D Details | D1–D4 | valid image loads; honest placeholder without image; long names no overflow; three same-price plans of one pool stay distinct (canonical `ci_` ids) |
| E Recheck | E1–E3 | "Offer rechecked", server expiry shown as `5 Oct 2026, 22:07 (Asia/Dubai)`, no Book/Pay/Confirm/Hold control |
| F Price changed | F1–F3 | previous and current total shown; no "rechecked" until the agent accepts; then confirmed at the new total |
| G Unavailable | G1 | sold out after search: "no longer available", no inventory allocated |
| H Expired | H1 [injected], H2 real | real API returns `rechecked` then `offer_expired` after the server expiry |
| I/J Stale, ON_REQUEST | I1, J1 | stale supplier hotel not offered; ON_REQUEST labelled and not selectable |
| K Shared pool | K1, K2 | three plans of a pool of 1 recheck without multiplying stock; when the pool is sold out all three are unavailable |
| L Session/logout | L1, L2 | revoked session returns to sign-in with the notice; sign-out clears state and the API refuses the old session |
| M Cross-tenant | M1, M2 | tenant B cannot act as A (403), sees only its hotel, cannot recheck A's offer; no `hotel.search` is 403; unauthenticated is 401 |
| N Failure and retry | N1, N2, N3 [injected] | unreachable API shows an error, keeps criteria, retry works; a slower older search cannot overwrite a newer one |
| O Mobile/keyboard/a11y | O1 (390/768/1280), O2–O9 | no overflow, keyboard destination and Enter-to-search, visible focus, one main landmark, axe A/AA clean on results and on the rechecked detail, live regions, no page errors |
| P Booking/payment disabled | P1, A5, E3 | booking and hold endpoints closed by the server; context says disabled |
| Q No allocation | Q1–Q3 | availability, pool, hold, booking and ledger counters unchanged by every search and recheck |

## Checks run on the tested head (local execution; none CI-observed)
| Check | Result |
| --- | --- |
| `pnpm check:architecture`, `check:schema` | pass |
| `pnpm type-check` (14 tasks) | pass |
| `pnpm lint` | pass (one existing warning in `inventory-admin.service.ts`) |
| Agent unit tests (`node --test`) | 103/103 (new: expiry formatting, session events, pagination window) |
| Other package tests (`turbo run test --filter=!@bedbanks/api`) | 13/13 tasks |
| Config tests (`tools/deployment`, agent `next-config`) | pass |
| API e2e subset on the strict role: agent, contracted inventory, inventory, strict-runtime, RLS, search, recheck, tenant | 22 suites, 193 tests pass |
| Production Agent build | pass |
| Browser journey | 50/50 |

No API, domain or database code changed in this mission, so the full API e2e suite was not re-run; it was last run in full on the merged `main` work (64 suites / 558 tests) and the relevant subset above was re-run here.

## Config fail-closed (`docs/evidence/agent-dubai-mvp/config-matrix.txt`)
Valid hosted URL accepted; missing `API_INTERNAL_URL` with `VERCEL=1` refused; `http://` and loopback refused on Vercel; credentials in the URL refused; a path other than `/api/v1` refused; local default only when not on Vercel. `next.config.mjs` refuses to load with `VERCEL=1` and no URL. The built client bundle contains none of: the API internal URL, `API_INTERNAL_URL`, a database URL, the runtime password or the runtime role name. `NEXT_PUBLIC_AGENT_API_URL` remains an optional public override only (same-origin default).

## Runtime role
Application connection: `fbeds_api_login`, member of `fbeds_api`, not superuser, not BYPASSRLS, owns nothing (verifier passes; the scale harness prints `restrictedRuntime: true`). The owner credential was used only to prepare the disposable databases and to read evidence counters. Cross-tenant, missing tenant context and no-write properties were exercised (M1, Q1–Q3; existing strict-role e2e). No schema or privilege change was needed.

## Performance observations (disposable, strict role; observed, no targets)
Browser journey: search 271–389 ms, recheck 131–253 ms. `inventory-scale.ts` on the strict role (`docs/evidence/agent-dubai-mvp/scale-*.json`):

| Hotels | Plans | Search p50 / p95 | Recheck p50 / p95 | Wrong results | Concurrency wrong pool counts |
| --- | --- | --- | --- | --- | --- |
| 1 | 3 | 23.3 / 60.1 ms | 18.5 / 21 ms | 0 | 0 |
| 10 | 30 | 47.4 / 74.9 ms | 18.5 / 54 ms | 0 | 0 |
| 100 | 300 | 642.2 / 689.7 ms | 17.3 / 24.1 ms | 0 | 0 |

Search time grew about 13x for 10x the hotels in one unpaginated call; the Agent pages results by 25. Not treated as a defect here.

Follow-up (perf/agent-search-100-hotels): reading rate plans 100 hotels per batch instead of 25 cut the 100-hotel search from 50 to 17 queries. Same harness, strict role: 100 hotels search p50 / p95 239.9 / 280.5 ms, 261 offers, 0 mismatches, 0 wrong rechecks, 0 wrong pool counts (1 hotel 24 / 68.6 ms; 10 hotels 34.8 / 81.2 ms). The table above is the pre-change measurement.

## Files changed
Agent: `app/globals.css`, `components/agent-auth-gate.tsx`, `agent-portal.tsx`, `agent-workspace.tsx`, `booking/booking-review.tsx`, `search/agent-search-view.tsx`, `lib/api-client.ts`, `lib/format.ts` (+test), `lib/search-page.ts` (+test), `lib/session-events.mjs`/`.d.mts` (+test), `services/hotel-service.ts`. Harness: `tools/admin-ops-verify/seed-agent-mvp.ts`, `verify-agent-mvp.cjs`. Evidence: `docs/evidence/agent-dubai-mvp/`. This record.

## Known limits and decisions
- The search form's nationality defaults to India in the client state; a saved choice per user replaces it, and an invalid override never silently changes it. Left as is; it is a product default, not an evaluator rule.
- Destination resolution stays Dubai-only through the canonical catalogue; no INR, FX or extra markets were added.
- The client sends `x-fbeds-tenant-id`; the server verifies it against the session's memberships (a mismatched tenant is 403, M1). It is a selection among memberships, not an identity claim.
- Booking review/checkout components still exist for a future enabled workspace, shown only when the server context says booking is enabled; the server gates remain authoritative (P1).

## Hosted status and blockers
Read-only Vercel metadata inspection was attempted. `list_projects` returned the team's projects (candidates `fbeds-agent` and `fbeds-agent1`), but `get_project` and `list_deployments` answered 403 ("re-authenticate to this scope"), so Root Directory, production branch, environment-variable names and the live deployment could not be inspected. **No hosted Agent was verified.** Hosted acceptance (a real hosted deployment serving the Agent, sign-in, Dubai search and recheck) remains to be done by the owner.

## Safety declarations
PRODUCTION_DB_MIGRATION_EXECUTED=NO; PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO; PRODUCTION_DEPLOYMENT_EXECUTED=NO; DNS_OR_ALIAS_CHANGED=NO; LIVE_SUPPLIER_ENABLED_BY_THIS_WORK=NO; BOOKING_ENABLED_BY_THIS_WORK=NO; PAYMENT_ENABLED_BY_THIS_WORK=NO. Only disposable local PostgreSQL databases were written (fixtures, session deletion and counter changes for failure scenarios); no `prisma db push`, production seeding or reset.

## Reproduce
```
pnpm --filter @bedbanks/api prisma:migrate:deploy              # disposable DB only
PROVISION_DATABASE_URL=<owner> API_RUNTIME_LOGIN_PASSWORD=<secret> pnpm --filter @bedbanks/api ops:provision-api-runtime-role
(cd apps/api && DATABASE_URL=<owner> NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-agent-mvp.ts)
# API on the runtime login (port 3002, BOOKING_ENABLED=false) and a second one with AGENT_OFFER_TTL_MS=1500 (port 3004)
API_INTERNAL_URL=http://127.0.0.1:3002/api/v1 pnpm --filter @bedbanks/agent-portal build && (cd apps/agent && pnpm exec next start --port 3003)
OWNER_DATABASE_URL=<owner> node tools/admin-ops-verify/verify-agent-mvp.cjs
```
