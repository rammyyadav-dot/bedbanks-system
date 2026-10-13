# Browser journeys

Real-browser tests of the Admin console and the Agent portal against the **real stack**: the Nest API, the Next apps, PostgreSQL with forced row-level
security, and Redis. Nothing is mocked. They prove what a person actually meets, which unit and API tests cannot (a page that crashes on load, a button a
read-only user should not see, a price an agent really reads).

## Run

```
# a disposable local PostgreSQL (migrations applied) and Redis, e.g. the CI cluster on 5433 and Redis on 6390
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/fbeds_ci pnpm test:browser
```

The suite refuses any database that is not local and disposable (`fbeds_ci` or `p0N_*`). It starts the API (port 3902), the Admin (3901) and the Agent
portal (3900), seeds a fresh tenant with a unique name, and removes everything it created afterwards.

## What is covered

| File | Journey |
|---|---|
| `00-sign-in` | No session is sent to sign-in; a wrong password is refused; the right one opens the console |
| `10-guided-setup` | Create a plan in the guided setup, price it from another plan (-10%), add a long-stay promotion (bad input stopped), review the checklist, request activation, **a second person approves and activates** |
| `20-agent-sees-it` | An Agent searching Dubai sees the activated plan at the exact price worked out by hand in minor units (derived rate, then promotion, then margin) with the promotion named; suspending the plan removes it from search |
| `30-csv-import` | Paste a rate sheet: good rows accepted, a bad row rejected and acknowledged, accepted cells applied together and audited; an unknown plan writes nothing |
| `40-permissions-and-tenants` | A read-only user is offered no edit and is refused by the API; another company's operator sees nothing; the requester cannot approve their own activation |

## What is not covered, and why

- **The API runs as `NODE_ENV=test` with the runtime-role guard off.** That is the only way the API lets the owner connection serve authoring (rates are
  written through a privileged path, ADR 0032). The locked-down role is certified separately by `apps/api/scripts/strict-role-boot-smoke.cjs`.
- Admin and Agent run on the Next development server, not a production build.
- Booking, payment and the supplier hand-off are not driven through the browser. Cancellation and voucher terms are covered by the database tests
  (`booking-cancellation`, `booking-documents`).
- Hosted infrastructure (S0) is certified by a person, not by this suite.
