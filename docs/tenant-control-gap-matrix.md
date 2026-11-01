# Tenant Control Center: baseline and requirement matrix

Baseline: `work`, SHA `5e145867c5daaad02b83475c832a78ab72e172ae`, clean. Feature branch `feat/tenant-control-center`. Scope is fBeds only; no UAEWB/fabBeds integration, merge, production provisioning, deployment or booking/payment enablement.

| Requirement | Existing | Partial | Missing | Security risk | Implementation action |
|---|---|---|---|---|---|
| Explicit tenant context | Auth/session and TenantContextGuard | Settings selected owner/first | Consistent Settings context | Wrong membership permission | Use validated selected tenant for guard/service; explicit UI choice |
| Strict-role Settings | Scoped canonical service and DTO | Runtime deliberately denied writes | Certified authoring connection | Broadening API privileges | Dedicated restricted role, no ordinary runtime grants |
| Tenant directory | Audited read-only list | No filters/counts/paging | Control Center directory | Directory identity/finance disclosure | Server filter/order/paging, authoritative metrics, safe selected fields |
| Tenant overview | Membership/booking count | Support audit | Business readiness/tabs | Unsupported totals presented as fact | Scoped domain counts, nullable bookings/finance, readiness remediation |
| Business profile | Tenant name/slug/status | No legal metadata | Governance profile | Unsafe global edits | Scoped versioned audited profile, unique normalized registration |
| Onboarding | Identity provisioning is operator-only | No secure email invitations | Guided create UI | Automatically active accounts | Five-step wizard, existing verified admin, transactional inactive creation |
| Memberships | Canonical multi-tenant membership and roles | No revocation governance | Safe attach/revoke | Self escalation / final admin removal | Dedicated platform permission; soft revoke, final owner guard, version/audit |
| Roles | Formal UserRole/RolePermission; platform assignments | Canonical separate access module | Tenant-tab role view | Tenant owner becoming platform admin | Read formal keys; no platform writes from membership controls |
| Lifecycle | ACTIVE/SUSPENDED; active-only guards | Canonical maker-checker | Tenant request/decision UI | Unapproved suspension/activation | Reuse ApprovalService, independent approval, execution readiness/version |
| Existing servicing on suspension | Existing queue/finance guards | Active-only context | Servicing exception | Broad new commercial access | Explicit existing queue/finance metadata, separate servicing membership context; retain gates |
| Compliance | No controlled document workflow | Legal data unmodeled | Independent decision | Public verification documents | Record legal profile and independent decision; upload remains gated |
| Commercial | Contracts, restrictions, markup rules and supplier mappings | No platform summary | Tenant summary | Metadata enabling distribution/pricing | Scoped canonical record counts and preferences; no writes |
| Finance/credit | Canonical finance and approval/ledger domains | Strict API intentionally lacks protected reads | Approved platform finance surface | Inferred balances / manual overrides | Honest unavailable state, no wallet/ledger grant or mutation |
| Audit | Immutable scoped AuditEvent | No tenant timeline | Filtered activity UI | Sensitive raw payload leakage | Permission-gated page, actor/action/entity/date filters; safe event fields |
| Closure/retention | Dependent bookings/contracts/audit | No approved archival policy | Closure workflow | Cascading business-critical deletes | No tenant DELETE grant/action; closure unavailable |
| Certification | Broad unit/E2E/CI and role verifiers | No tenant-control acceptance | New strict tests/browser flow | Claims without execution | Disposable replay/drift, real restricted-role HTTP suite, unit and browser evidence |

Known remaining work: secure invitation delivery and acceptance; verified private document storage; formal role-assignment mutations through canonical RBAC; member pagination/search beyond the bounded detail view; last-activity filtering; supplier/hybrid entitlement readiness; approved finance read integration; full cancellation/refund servicing for suspended tenants; closure retention governance; complete WCAG audit. See certification results for broader baseline/environment failures. A draft PR is a review artifact, not production readiness certification.
