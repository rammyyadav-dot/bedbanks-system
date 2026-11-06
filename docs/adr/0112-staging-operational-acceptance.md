# ADR 0112: Staging operational acceptance

Status: accepted for implementation. Accepting this ADR does not deploy staging and does not sign the exit gate.

## Context

Architecture section 11 requires SLIs and SLOs for authentication, search latency, recheck success, booking completion, cancellation completion, connector health and job backlog, plus alerts on unknown booking outcomes, webhook failures, queue backlog, authentication anomalies, authorization denials and failed migrations. Release certification on 2026-11-02 closed the infrastructure alarm code and left SNS delivery, business signals, the hybrid-search budget and every hosted deploy unverified. Staging promotion runs only from `main`, only when `STAGING_PIPELINE_ENABLED` is true, and never from a pull-request branch (ADR 0090).

## Decision

1. **Objectives live in `docs/ops/slo-catalog.json`.** They are provisional staging objectives. A production commitment exists only after the four acceptance roles sign a record whose SHA is the commit that was deployed.
2. **The API emits one JSON line per finished request** (`event` `ops.sli`) with a fixed signal, outcome, status, duration and an optional request id. Health probes are omitted. Query strings, headers, cookies, bodies, tenant ids and guest data are omitted. Login failures stay on the authentication signal so they do not trip the authorization-denial alarm.
3. **CloudWatch metric filters and alarms** on the API log group count server errors for authentication, search, recheck, booking and cancellation, and authorization denials outside authentication. They publish to the existing alarm topic. The operations dashboard charts those series next to the load balancer, task and database metrics that already have alarms.
4. **Connector failure ratio stays on traces** until an owner confirms the ADOT collector in staging (ADR 0093). Job heartbeats stay on the existing reindex and compliance alarms.
5. **Acceptance evidence is produced on a disposable database** by `tools/ops/run-staging-acceptance.mjs`: tenant-isolation and authorization certification, inventory-hold concurrency, booking confirmation idempotency, the logical restore drill, the incident tabletop, the dependency audit and the privacy log review. Hybrid search load is recorded against the 200 ms budget and does not by itself deploy anything.
6. **The exit gate fails closed.** `tools/ops/staging-signoff.mjs` accepts a record only when engineering, operations, security and product each sign the same deployed SHA with the statement in `docs/runbooks/staging-acceptance.md`, and the record includes the access-assignment review in Amendment 1. Missing roles, a missing access review, a mismatched SHA, or a blocker (search budget, restore, or no staging deploy) leave the gate open. This repository does not contain those signatures.

## Consequences

- Terraform apply of `sli.tf` is an owner action, like the rest of the stack. Until that apply, the dashboard and the new alarms do not exist in AWS.
- Custom metrics stay at zero until the API revision that emits `ops.sli` is serving.
- Booking creation and cancellation SLIs measure traffic only when an owner has enabled booking for that environment. While booking is off, HTTP 503 from the booking gate is a server error and would page if clients call those routes. Leave booking disabled and do not point synthetic traffic at it.
- Rollback is to remove the middleware and `sli.tf`. No migration is involved.

## Verification

Unit tests cover classification and redaction. `pnpm check:aws-governance` fails if the dashboard or a required SLI alarm metric disappears. The acceptance runner records what it actually executed. It does not contact AWS. `tools/ops/staging-signoff.test.mjs` refuses a sign-off that omits the access-assignment review.

## Amendment 1 — Access assignment review is part of the exit gate

Status: accepted for implementation. Accepting this amendment does not sign the gate and does not change who holds a role.

Access reviews (`apps/admin/app/(dashboard)/access-review/page.tsx`) already show, read-only, who holds which authority in the signed-in tenant (ADR 0017). That evidence was not required before a staging release. It is now a pre-release staging checklist item.

Before the gate can return `SIGNED`, `docs/ops/staging-acceptance-signoff.json` includes `accessReview` as specified in `docs/release-checklists/staging-access-review.md` and illustrated in `docs/runbooks/staging-acceptance.md`. The reviewer is the security signer. Counts are the aggregates from the page (`total`, `holdingSensitive`, `noRole`, `inactive`, `neverLoggedIn`, `staleLogin`) and `staleLoginDays` is 90, the same window the API uses. Each flag (`HOLDS_SENSITIVE`, `NO_ROLE`, `INACTIVE`, `NEVER_LOGGED_IN`, `STALE_LOGIN`) has a disposition of `accepted` or `remediated`. A remediated flag means assignments were changed in Roles & Permissions and the counts are from a second read of this page. The record contains no member name, email, user id or permission list. A missing review, a reviewer who is not the security signer, a flag without a disposition, or a pasted member list leaves the gate open.

The same checklist row is required on the AWS staging readiness list and on the production migration release list whenever that release was rehearsed on staging. The page itself states that a staging release stays unsigned until the review is recorded. The page still changes nothing.
