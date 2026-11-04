# Admin Console stabilization

Status: **not a production certification.** This note records the release gate and the checks added with ADR 0112. It does not approve a deploy.

## Still blocking production

| Blocker | State |
|---|---|
| Hosted Admin deployment and the authoritative API origin | Not certified in this change. No Vercel, ECS, Neon or AWS account was contacted. |
| Live supplier connectivity | Not present. Connector and search-monitor screens do not establish a commercial supply path. Search monitor reads recorded outcomes. |
| Booking and finance end-to-end production evidence | Not produced here. Mutation workflows below are implemented product code, not a certified pilot. |
| Exact-SHA clean CI, production build, and authenticated browser acceptance | Not claimed by this document. Admin `type-check` now generates route types before `tsc`. A full CI run on the merge SHA is still the gate. |

## What changed

- Browser, server and Agent clients accept JSON only as `{ success: true, data }`.
- Every live department module must have a page that reaches an API route, or a hub that links to one that does.
- Dashboard pages outside the catalogue are redirects or registered unavailable routes (`apps/admin/lib/route-registry.ts`).
- `/notifications` no longer dispatches vouchers from a prefilled form.

## Finance: read-only views and uncertified mutations

Read-only (display ledger or issued-document figures; this list is locked by `financeReleaseScope.readOnly`):

- `/finance/wallets`
- `/finance/receivables`
- `/finance/payables`
- `/finance/refunds`
- `/finance/credit-notes`
- `/finance/booking-postings`
- `/finance/booking-revenue`

Implemented mutation workflows that are **not** production-certified (`financeReleaseScope.uncertifiedMutation`):

- `/finance/ledger` (adjustment post)
- `/finance/funding`
- `/finance/ledger-adjustments`
- `/finance/periods` (period close)
- `/finance/chart`
- `/finance/reconciliation`
- `/finance/supplier-settlements`

`/finance` and `/finance/payments` are not workspaces. They show no balances and post nothing.

## Certification sequence

Do these in order. Do not open a new Admin surface while a step is open.

1. Freeze the merge SHA. Run clean Admin type-check, lint, tests and a production build on that SHA. Confirm `next-env.d.ts` still points at `.next/types`, not `.next/dev/types`.
2. Check every live route against its API with a signed-in staging session, including permission denial, an expired session, a tenant switch and an API outage.
3. Add authenticated browser coverage for accessibility, keyboard and a narrow viewport on the hotel workspace and one dense finance table.
4. Certify one hotel → contract → rate plan → inventory → sellability path, then one booking, hold, cancellation and reconciliation, including four-eye activation and the audit event plus request id.
5. Promote one immutable artifact, restrict it to named operators, enable one supplier and limited inventory, and reconcile every pilot booking and funding event. Keep a rollback drill.

## Explicitly deferred

Unavailable routes that still explain a destination (`/users`, `/reports`, `/pricing`) stay until bookmarks are gone. Performance budgets, bundle monitoring, consistent unsaved-change guards, shared pagination and request-id presentation, and visual regression for the hotel workspace are not part of this change.
