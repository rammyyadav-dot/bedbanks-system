# ADR 0112: Admin stabilization and a fail-closed API envelope

## Status

Accepted.

## Context

The Admin Console is functionally broad: the department catalogue exposes dozens of live modules, and finance screens include both ledger reads and money-moving workflows. Production approval was being discussed as if those screens were already certified.

Two client behaviours disagreed with the API contract in `packages/contracts/src/envelope.ts`:

- `@bedbanks/api-client` `unwrapEnvelope` returned a bare JSON body when `success` was not `true`.
- The Agent search, destination and booking clients treated `{ data }` as success, and otherwise fell through to the raw body.

The Admin browser client and the Admin server client already required `success: true`. A response that was HTTP 200 but not the API envelope could still be treated as data on the Agent path. The NestJS interceptor wraps controller results as `{ success: true, data }`, including results that set a non-2xx status and still return a value (for example `price_changed`).

Generated Admin type-checking also depended on whatever `.next` directory a previous `next dev` had left behind, including `.next/dev/types`.

## Decision

1. **Fail closed.** `isSuccessEnvelope` is the only acceptance check. A body counts as success only when `success === true` and the `data` key is present (`data` may be null). The shared HTTP client throws `API_MALFORMED_RESPONSE` otherwise. Admin browser and server requests use the same check. Agent search, recheck, destinations and booking parse success the same way. HTML document downloads stay outside the JSON envelope.
2. **No new Admin capability in this change.** Placeholder routes stay out of the sidebar. `/notifications` no longer posts cancellation vouchers or shows a prefilled booking. `/finance`, `/finance/payments` and `/distribution` say which live screen to use, and they still render no records.
3. **Route registry.** `apps/admin/lib/route-registry.ts` lists unavailable routes, redirects, and the finance release split. A dashboard page that is not a live module, a child of one, or a redirect must be registered. Tests resolve each live module to at least one `/admin`, `/supply`, `/platform` or `/auth` call in the page or the loader it imports.
4. **Finance release scope.** Read-only finance screens display ledger figures. Funding, adjustments, period close, chart setup, reconciliation decisions and supplier settlements are implemented product workflows and are not production-certified. Presence of a control is not authorization to move money in production.
5. **Type-check hygiene.** Admin `type-check` runs `next typegen`, then `scripts/ensure-certified-types.mjs` removes the `.next/dev/types` include Next adds back, then `tsc`. Committed `next-env.d.ts` references `.next/types` only. A previous `next dev` cache cannot change the certified check.

## Consequences

- Callers that depended on an unwrapped 200 body now fail. The API already sends the envelope.
- This ADR does not certify a hosted Admin origin, a live supplier, booking reconciliation, or an exact-SHA production deploy. Those remain release blockers, recorded in `docs/admin-console-stabilization.md`.
- Browser accessibility, keyboard, responsive and signed-in authorization runs are still required before production approval. The new tests are static.

## Not done

- Removing every non-catalogue URL. Bookmarks for `/users`, `/reports` and `/pricing` still explain where to go.
- Performance budgets, visual regression, and unsaved-change coverage beyond the hotel workspace.
- A production pilot.
