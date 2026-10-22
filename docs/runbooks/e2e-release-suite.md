# End-to-end release suite: what it checks and how to run it

This is the plain-language guide. The suite signs in to the three real portals in a real browser against a real (throwaway) database, the way a person would, and checks the things that must never break.

## What it checks (30 checks)
| Area | What a person would see | Checks |
|---|---|---|
| Security boundary | Strangers are refused; a wrong password gives a generic message; a foreign website cannot sign anyone in or out; logins are HttpOnly and Secure; one agency can never see another agency's hotels; staff only reach what their role allows; signing out really ends the session | S1–S10 |
| Agent portal | Sign in, search Dubai for 2 adults, see two hotels at AED 900.00 for 2 nights, open a room, run the authoritative recheck, see "Booking is not enabled for this workspace", sign out | A1–A3 |
| Admin console | Sign-in redirect, dashboard, hotel directory and supplier register show only this tenant, a staff member without permission is told so and sees no data | D1–D6 |
| Supplier extranet | Each supplier sees only its own hotel; read-only members; a revoked member sees nothing | X1–X6 |
| Booking stays closed | Holding or prebooking an offer is refused (503), a recheck changes nothing, a wrong price is not accepted, and the database shows no new booking, hold, ledger or finance rows | B1–B4 |
| Whole chain | The same hotel is seen by the supplier, the admin and the agent at one whole-number AED price; another tenant's hotel is never in the chain | J1 |

## How to run it
Needs: Node 24, pnpm, a local PostgreSQL 16 with pgvector on 127.0.0.1:5432, and `psql`.
1. `pnpm install`
2. `pnpm --filter @bedbanks/api prisma:generate`
3. Build the portals fresh: `pnpm --filter ./apps/agent build`, then the same for `admin` and `supplier`
4. `pnpm --filter @bedbanks/e2e exec playwright install chromium` (first time)
5. `pnpm --filter @bedbanks/e2e e2e`

The database login defaults to `postgres:postgres@127.0.0.1`. Override with `E2E_PG_ADMIN_URL`. The suite refuses any host that is not this computer.

Faster loop while writing tests: `pnpm --filter @bedbanks/e2e e2e:up` starts the stack and leaves it running, then `E2E_REUSE_STACK=1 pnpm --filter @bedbanks/e2e e2e`; stop it with `e2e:down`.

## Live screenshots of the Supplier extranet
`tests/07-supplier-screenshots.spec.ts` signs in as the Alpha editor and saves full-page PNGs of every supplier route (plus a mobile view) to `e2e/.artifacts/screenshots/supplier/`. It records what a supplier sees today, including the "not available" states, and is part of the normal run. To refresh only the screenshots: `E2E_REUSE_STACK=1 pnpm --filter @bedbanks/e2e exec playwright test tests/07-supplier-screenshots.spec.ts`.

Live Admin screenshots: `pnpm --filter @bedbanks/e2e e2e:screenshots` signs in as the preview admin and writes full-page PNGs of the primary Admin pages to `e2e/.artifacts/screenshots/admin/`. It is opt-in (`E2E_SCREENSHOTS=1`) and skipped in the normal suite. Pages show what the preview admin's role is permitted to see, so some dashboard tiles read "Not permitted".

## Safety
It only ever drops and recreates the database named `fbeds_preview_xt`. Test passwords are random per run, kept in a private temporary file and deleted afterwards. It never turns on booking, payments or live suppliers.

## When it fails
Open the CI artifact `e2e-release-suite-report`: screenshots, traces and the API and portal logs. First check that the portals were rebuilt from the current code; a stale build looks like "no hotels matched" with a "mapping could not be verified" notice.

## Known gaps found while building it (not fixed here)
- Sign-in audit events are not saved under the strict database role: the API logs `auth_audit_persist_failed` on every login. The audit insert is allowed, but Prisma's `create` also reads the row back, which the audit table's read policy denies. The login still succeeds, but the sign-in audit trail is empty.
