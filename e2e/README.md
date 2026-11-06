# End-to-end release suite

Browser and database-backed release tests for the Admin, Agent and Supplier portals against the real API and a disposable PostgreSQL running under the strict runtime role. See `docs/runbooks/e2e-release-suite.md` (how to run, what it checks) and ADR 0064.

`pnpm --filter @bedbanks/e2e e2e` starts everything, runs the release checks and cleans up. It needs freshly built portals and a loopback PostgreSQL. Booking stays off. `pnpm --filter @bedbanks/e2e e2e:booking` is the separate opt-in: it starts the same disposable database with `BOOKING_ENABLED=true` and confirms one contracted Dubai stay in the Agent portal. `tests/09-admin-browser-security.spec.ts` visits every live Admin module, then checks expired sessions, a forged tenant cookie, API outages, unauthorized controls, axe and 1280/768/390 layouts.
