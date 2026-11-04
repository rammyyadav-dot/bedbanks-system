# ADR 0112: Strict API envelope and Admin browser acceptance

## Status
Accepted.

## Context
Admin, Agent and Supplier each decided for themselves when an HTTP body was a successful API call. The shared client treated some non-envelopes as data, and a `{ success: false }` body on HTTP 200 could be read as a result. The Admin catalogue now has more than 37 live modules. Route, session, tenant, outage, permission and viewport behaviour were covered in pieces, not as one acceptance pass.

## Decision
1. `@bedbanks/contracts/envelope` is the only reader. `parseApiEnvelope` accepts HTTP 2xx as data only for `{ success: true, data }` (`data` may be null). Any other 2xx body is malformed. `{ success: false }` keeps the API code, message and string or object details. A non-2xx body is a failure even when it is not JSON.
2. The Admin browser client, the Admin server client, the Agent HTTP client and the Supplier portal all use that reader. A malformed 2xx is never shown as saved or as an empty list.
3. The Admin browser sends POST, PUT, PATCH and DELETE only after capabilities for the active tenant have loaded. A declared permission that is absent sends nothing. The API remains the authorizer.
4. Acceptance lists every live module from `liveDepartmentModules()` (at least the original 37). Each module has a real page. Playwright, when the release stack is up, visits each route, checks 1280, 768 and 390 pixel layouts, runs axe on sign-in, the dashboard and hotels, refuses a cleared session and a forged tenant cookie, and checks that a caller without the module permission sees no submit control and sends no mutation.

## Consequences
Callers that depended on a bare JSON object from HTTP 200 now get a malformed-response error. `{ success: false }` on HTTP 200 surfaces the API code instead of being treated as success or as a generic invalid response.

## Rollback
Revert the envelope reader and the four call sites. The catalogue helper and the acceptance tests can stay.
