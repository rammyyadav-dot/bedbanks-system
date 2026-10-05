# ADR 0037: Existing-day capacity edits and column-only attribution

## Decision
Proposed implementation tested on disposable PostgreSQL; persistent provisioning remains separately authorized.

Use the existing API principal with forced tenant RLS and application preview/apply permissions. Grant UPDATE only on InventoryPoolDay capacity and updated_at. Preserve sold, held, identity and all provenance/freshness columns. Missing nights are invalid rather than initialized here; INSERT, DELETE, pool authoring and stock moves remain privileged.

Attribution SELECT needs InventoryHoldNight tenant_id, counter_kind, pool_day_id, hold_id, quantity and InventoryHold id, tenant_id, rate_plan_id, status. These cover every join/filter/group expression and the tenant-only RLS policies. No other hold fields or hold writes are granted.

## Alternatives
A separate authoring principal can keep the normal API read-only but introduces another secret, pool, routing and tenant-context boundary. This capacity-only operation needs no such broader capability: existing application RBAC, two-column SQL UPDATE and forced RLS provide three distinct enforcement layers. Do not treat a process grant as a user permission.

Broad table grants and SECURITY DEFINER wrappers were rejected. Full pool creation/membership, Quick Update and hold lifecycle remain outside this decision.

## Freshness and missing days
The editor merged in PR #262 set source=ADMIN and cleared fresh_until, making a capacity edit capable of reviving stale supplier inventory. Existing rows now retain all provenance and freshness metadata. Missing rows remain unknown; explicit capacity is not evidence that a supplier night is current. Operators must initialize dates through an independently controlled authoring workflow.

## Convergence and verification
Table REVOKE does not remove column ACLs. Provisioning clears existing column ACLs before granting the contract; the new forward migration 202610270001_strict_runtime_role_pool_freshness does the same for the three affected tables. Verification rejects missing, extra and broad hold reads and capacity writes. RLS policies are unchanged.

## Compatibility and release
Clients retain the existing response shape, as established by merged PR #262 (no creation fields). Missing dates return invalid previews and atomic 422 refusal at Apply. This is a deliberate tightening of the editor. Deploy code and apply/provision the approved contract together only after separate release authorization. Prior runtimes with broader grants are not certified by this document.

Rollback is an owner-operated privilege revocation/reprovision using the prior contract and a code rollback; never edit migration history. No persistent action is executed by this work. F01 and its pinned candidate remain untouched.
