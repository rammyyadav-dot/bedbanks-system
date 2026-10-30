# Incident response

Contain access, preserve logs and correlation IDs, rotate impacted credentials, assess tenant/guest/financial exposure, notify owners, and document remediation. Never paste live credentials or guest data into tickets or chat.

## Severity

| Sev | Meaning | Examples | Response |
|---|---|---|---|
| 1 | Tenant isolation, credential, guest-PII or money-integrity failure; total outage | cross-tenant read, leaked secret, double-booked or double-charged booking, ledger imbalance, no healthy API targets | Page on-call now; incident commander named within 15 min; owner informed within 1 h |
| 2 | Major capability degraded | supplier connector failing, search over budget, bookings stuck in a non-terminal state, 5xx alarm | On-call within 30 min; owner informed same day |
| 3 | Minor or contained | single-tenant UI fault, one failed job with a retry | Next business day |

When unsure between two severities, take the higher one.

## Roles

- **Incident commander (IC):** decides, assigns, and is the only person who declares mitigation or resolution.
- **Operator:** runs the commands (rollback, rotation, restore). One operator at a time.
- **Scribe:** keeps the timeline (UTC) in the incident record: detection, decisions, commands run, who approved.

## First 15 minutes

1. Declare the severity and name the IC. Open an incident record; start the timeline.
2. Stop the bleeding before diagnosing: roll back the application (`docs/runbooks/rollback.md`), disable the affected connector or feature, or suspend the affected tenant/user. Do not drop or edit database objects.
3. Preserve evidence: note the deployed task-definition revisions and image digests, the alarm and its time window, and the request IDs or `AuditEvent` ids involved. CloudWatch log groups are retention-controlled (`docs/aws-log-retention-policy.md`); do not shorten retention during an incident.
4. Scope the blast radius: which tenants, which users, which bookings or ledger entries, which time window. Use read-only queries through the break-glass path; every privileged action creates an audit event.
5. Decide whether guest PII, credentials or money were exposed or moved wrongly. If yes, escalate to Sev 1.

## Playbooks

### Credential or token exposure
Rotate per `docs/aws-secret-rotation-runbook.md` (supplier credentials, database roles, session secrets). Revoke active sessions for affected users. Confirm no credential value appears in logs, the repository history or CI output. Treat the old value as compromised permanently.

### Suspected cross-tenant access
Run `pnpm --filter @bedbanks/api test:security` against a disposable clone and `ops:certify-tenant-control` to see whether the controls still hold. Query `AuditEvent` for denials and for any request whose actor tenant differs from the data tenant. Suspend the affected route or role if the leak is reproducible. Notify every affected tenant owner.

### Supplier outage or bad supplier data
Supplier failures must surface; do not enable a fallback that serves stale or zero-priced inventory. Disable the connector for new searches, keep existing bookings reconcilable, and let the reconciliation job resolve in-flight mutations once the supplier is back. Check `SupplierMutation` and `BookingSupplierCall` for rows left in a sending state.

### Booking, wallet or ledger inconsistency
Freeze the affected flow (disable booking for the tenant), then follow `docs/runbooks/finance-reconciliation.md`. Corrections are made by posting adjustments or reversals (`ADR 0100`), never by editing ledger or audit rows. Replays must use the original idempotency key.

### Data loss or corruption
Follow `docs/runbooks/recovery.md`: restore to a NEW instance by point-in-time, validate, then repoint the `DATABASE_URL` secrets. Never restore over the live instance.

### Bad release
`AWS rollback` workflow for the affected service; Vercel instant rollback for portals still hosted there. If the release included a migration the previous code cannot run against, stop and escalate to the owner.

## Communication

Internal updates every 30 minutes for Sev 1 and every 2 hours for Sev 2, even if the update is "no change". State what is known, what is not, and the next update time. Customer or regulator notification is the owner's decision; the IC supplies the facts (scope, window, data classes, status). Do not speculate about root cause in external messages.

## Closing

Resolved means: customer impact ended, the cause is understood or explicitly unknown, and monitoring confirms normal behavior for at least one full alarm window. Within five business days publish a post-incident review containing the timeline, root cause, what detected it and how long that took, what mitigated it and how long that took, and dated, owned follow-up actions (including any missing alarm or test). Add regression tests and, where an invariant failed, an ADR or a `CLAUDE.md` rule change.
