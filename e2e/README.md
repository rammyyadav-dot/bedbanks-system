# End-to-end release suite

Browser and database-backed release tests for the Admin, Agent and Supplier portals against the real API and a disposable PostgreSQL running under the strict runtime role. See `docs/runbooks/e2e-release-suite.md` (how to run, what it checks) and ADR 0064.

`pnpm --filter @bedbanks/e2e e2e` starts everything, runs 30 checks and cleans up. It needs freshly built portals and a loopback PostgreSQL.
