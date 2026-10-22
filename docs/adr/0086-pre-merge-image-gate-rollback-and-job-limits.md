# ADR 0086: Pre-merge image gate, rollback workflow and job time limits

Status: **Built (workflows, guard and docs only; no application, schema or AWS resource change). Not yet run on GitHub.**

## Audit (2026-10-22)
Existing: CI (schema, migration certification, verify, e2e, website), Security (dependency audit, CodeQL, gitleaks), Terraform check (fmt, validate, mock-provider tests, checkov, actionlint), manual AWS images and AWS deploy with a promotion gate, and ECR scan-on-push. Gaps:
1. **Images were only built by the manual "AWS images" run from main.** A broken Dockerfile, a lockfile that no longer installs inside the image, or a vulnerable base image surfaced at release time, not in the pull request. No SBOM was produced.
2. **No rollback path.** `docs/runbooks/rollback.md` was two sentences; rolling an ECS service back meant hand-written CLI during an incident.
3. **No dependency review** on pull requests (the audit runs on the merged lockfile).
4. **Most jobs had no `timeout-minutes`**, so a hung job held an environment lock for the 6-hour default.
5. **`Dockerfile.web` used an unpinned `node:24-slim`** while the API image and CI services are digest-pinned.
6. **No local dependency stack**; `LOCAL_SETUP.md` assumed a hand-installed PostgreSQL without pgvector.

## Decision
1. `docker-build.yml` (PRs touching image inputs, pushes to main, weekly): hadolint (errors fail), build of the api runner, api migrator and the four portals without pushing, non-root check, Trivy scan (fixable HIGH/CRITICAL fail; exceptions in `security/trivyignore` with an expiry), CycloneDX SBOM artifact. Trivy and hadolint are downloaded and verified against pinned SHA-256 digests, the same approach as gitleaks, so no third-party action runs in the pipeline.
2. `aws-rollback.yml`: manual, environment-gated, shares the `aws-deploy-<env>` concurrency group. Restores the previous ACTIVE task definition revision (or a named one), refuses a revision whose image is not digest-pinned, waits for stability and verifies the service really settled on it (a circuit-breaker bounce is not success). Application code only; never touches the database.
3. `dependency-review` job in `security.yml` (pull requests, high severity).
4. Every job declares `timeout-minutes`; `tools/workflow-permissions-check.mjs` (part of `check:architecture`) enforces it.
5. `Dockerfile.web` pins the Node image by digest through a `NODE_IMAGE` build argument (Dependabot's docker ecosystem bumps it with the API image).
6. `docker-compose.yml` runs PostgreSQL (pgvector) and Redis at CI's pinned digests, bound to 127.0.0.1, for local development only.

## Consequences and limits
- The new workflows were validated with actionlint and ShellCheck and the guard tests, **not executed on GitHub, and the images were not built here (no Docker daemon in the authoring environment)**. First runs may need adjustment (for example a Trivy finding in the base image that needs a dated `trivyignore` entry or a base bump).
- `docker-build` is not yet a required status check; add its jobs to branch protection after one green run. `aws-deploy`'s promotion gate deliberately keeps its current required-check list.
- `dependency-review` needs the repository's dependency graph enabled; if it is off the job fails with a clear message and the setting must be turned on.
- Image signing and provenance attestation (cosign / buildx `--provenance`) are not added: ECS pins by digest from a commit-tagged immutable ECR tag, and attestation manifests change the digest semantics the deploy workflow relies on. Revisit with a verification step on the ECS side first.
- Rollback restores code only. A migration that already ran stays; follow `docs/runbooks/rollback.md`.
