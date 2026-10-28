# CTO remediation baseline — 2026-10-28

Source: 4e0db1a7e44a15bc5dd7757850f85d9c95001aaf. GitHub compare confirmed main identical on the audit date.
Archive SHA-256: a8c5435e75f36ccab0db7ae990588dc2b887aefe8efe7e52fb0d8cdbee5ce29d.
PR #298 was already merged on 2026-10-11; no conflict resolution was required.
Code change: Quick Update clears selection and preview when the contract or room filter changes, with visible guidance.

## Reproduction and results
Node 24.22.1, pnpm 10.4.1. Install with frozen lockfile, then generate Prisma Client before application checks.
For resource-safe validation use NODE_OPTIONS=--max-old-space-size=4096, NEXT_TELEMETRY_DISABLED=1, TURBO_TELEMETRY_DISABLED=1 and DO_NOT_TRACK=1.
Run Turbo tasks with --concurrency=1.

- Architecture aggregate: pass. Its default migration scan examined zero files in the ZIP-derived synthetic Git context.
- Type-check: 16/16 tasks pass (10 cached).
- Lint: 15/15 tasks pass.
- Build: 15/15 tasks pass, none cached; serialized run took about 2m7s.
- Existing Admin unit tests: 262/262 pass.
- Targeted API quick-update-rules and runtime-db-identity suites: 41/41 pass.
- Tooling tests: initial 145/156 pass; seven Git-dependent staging-plan failures were resolved by local Git initialization and that suite then passed 8/8. Workflow-lint tooling remains incomplete.
- Full-history migration safety scan: 61 findings for review, distinct from 56 baselined unindexed foreign keys.
- Full workspace tests, PostgreSQL lifecycle/concurrency and browser interactions are NOT certified by this run.

Initial parallel build exited 137. Type-check attempts before generation and under the default heap limit were superseded by the successful ordered setup/larger-heap run. Full workspace test attempt was stopped after generation-overlap compilation errors; targeted suites above were rerun after generation. An earlier lint attempt was blocked over implicit telemetry; the disabled-telemetry rerun passed.

## Remaining priorities
1. Bind Quick Update idempotency keys to normalized request digests and define legacy/actor semantics.
2. Retain immutable before/after detail beyond the current 20-row audit sample.
3. Test runtime database session identities and reachable owner-role paths.
4. Prove mixed-writer concurrency in PostgreSQL; some pool writers already share the hotel lock and the supply calendar uses Serializable isolation.
5. Certify booking lifecycle and external supplier connectors before named-environment enablement.

## Browser acceptance still required
Select rate plans and preview. Change each filter independently. Verify selection is cleared, the old preview cannot be applied, and reselection plus a fresh preview works. Also cover filter changes during an in-flight preview.

No production flag, migration, grant or deployment was changed. Keep this PR draft until required CI and browser checks are complete.
