# fBeds Enterprise Architecture

## 1. Purpose and current truth

fBeds is a multi-tenant B2B hotel bedbank and travel-distribution platform. It is designed to acquire, normalize, price and distribute accommodation supply to travel agencies, tour operators and other B2B buyers.

This document is the architecture authority for the fBeds monorepo. It separates the **implemented foundation** from the **target enterprise platform** so a UI, schema or mock route is never treated as a live commercial capability.

| Area | Current architectural position |
| --- | --- |
| Web applications | Separate Next.js applications in a pnpm/Turbo monorepo |
| API | NestJS control plane in `apps/api` |
| Data | PostgreSQL accessed through Prisma |
| Authentication | Opaque database-backed sessions; Secure, HttpOnly browser cookie; SHA-256 token hash persisted |
| Authorization | Tenant context, RBAC and audit are server-side concerns |
| Supply, pricing, search, booking and finance | Target bounded capabilities; only claim readiness once end-to-end validation is complete |
| External suppliers | Must be accessed through isolated connector adapters; no provider-specific type leaks |

---

## 2. System context

```text
Public website / Agent portal / Admin console / Supplier extranet
                              │
                    HTTPS + typed API contracts
                              │
                     NestJS API control plane
 ┌───────────────┬────────────┼─────────────┬───────────────┐
 Auth + RBAC     Catalogue    Search/Price  Booking/Finance Audit
 Tenant context  Contract     Inventory     Cancellation    Events
 └───────────────┴────────────┴─────────────┴───────────────┘
                              │
          PostgreSQL + Prisma │ Redis / object storage / jobs (target)
                              │
          Supplier, DMC, channel-manager and partner connectors
```

The browser is not a trusted enforcement point. Every tenant-scoped read or mutation is resolved and authorized by the API before data is returned or changed.

---

## 3. Monorepo ownership and deployment boundaries

| Path | Owner and responsibility | Deployment boundary |
| --- | --- | --- |
| `apps/website` | Public marketing, SEO, lead capture and routing to portals | Independent Vercel project |
| `apps/agent` | Buyer-facing B2B search, quote and booking operations | Independent Vercel project |
| `apps/admin` | Internal operations, catalogue, commercial, finance and governance workflows | Independent Vercel project |
| `apps/supplier` | Hotel, DMC and channel-manager supply onboarding and maintenance | Independent Vercel project |
| `apps/api` | NestJS REST API, domain orchestration, Prisma access and security controls | Independently deployed service |
| `packages/*` | Shared contracts, domain primitives, money/pricing utilities and connector abstractions | Versioned through workspace dependencies |
| `docs/` | Architecture decisions, operating guides, API and release evidence | Repository documentation |

Each frontend must call the API through typed, versioned contracts. No frontend may read the production database directly, embed supplier credentials or decide access policy.

---

## 4. Target application architecture

### Public website — `apps/website`

The public website is a marketing and conversion surface only. It provides product positioning, audience-specific landing pages, SEO content, demo/partner capture and safe routing to the appropriate portal. It does not expose inventory, rates, agent data or supplier operations.

### Agent portal — `apps/agent`

The agent portal is a tenant-scoped buyer workspace. Its end-state workflow is:

`authenticate → select/resolve active workspace → search → availability/recheck → price → prebook → book → voucher/servicing → cancel → ledger/audit`

A portal UI must show an explicit unavailable or no-results state when an underlying provider capability is not configured. Demo inventory must never resemble live supply unless clearly labelled and deliberately enabled in a non-production environment.

### Admin console — `apps/admin`

The admin application is the operational control plane. It governs destinations, suppliers, property content, room and rate mapping, contracts, markups, booking exceptions, finance, users, roles, tenant access, audit and connector health. Admin access is privileged and requires finer-grained permissions, immutable audit records for sensitive actions and separation of duties for finance or production configuration.

### Supplier extranet — `apps/supplier`

The supplier application serves hotels, DMCs and channel managers. Its end-state workflow is:

`supplier onboarding → organization verification → property onboarding → rooms/content → contracts → rates/availability/restrictions → promotions → booking servicing → settlement and reporting`

Supplier users can modify only supply belonging to their organization and only after API authorization. Contract publication and financially material changes require a controlled status transition and audit trail.

---

## 5. Core domain model

The platform uses provider-neutral canonical entities. Identifiers are stable UUIDs; tenant and organization ownership are explicit on every protected record.

| Domain | Canonical concepts |
| --- | --- |
| Identity and tenancy | User, Session, Tenant, Organization, Membership, Role, Permission, Active Workspace |
| Geography and content | Country, City, Destination, Property, Address, Amenity, Image, Policy |
| Accommodation | Property, Room Type, Occupancy, Meal Plan, Rate Plan, Allotment, Stop Sale, Restriction |
| Commercial | Supplier, Contract, Contract Version, Commission/Markup Rule, Promotion, Currency, Tax/Fee |
| Availability and pricing | Search Request, Availability Option, Rate Quote, Price Breakdown, Recheck, Quote Expiry |
| Booking | Prebook, Booking, Booking Item, Guest, Voucher, Amendment, Cancellation, Supplier Confirmation |
| Finance | Wallet, Credit Limit, Ledger Entry, Invoice, Credit Note, Settlement, Reconciliation |
| Integration | Connector, Credential Reference, Mapping, Import/Export Job, Webhook Event, Provider Reference |
| Governance | Audit Event, Approval, Support Case, Notification, Feature Flag, Data Retention Record |

Provider IDs and raw payloads remain inside the connector/integration boundary. Core search, pricing and booking services operate only on canonical models.

### Data integrity rules

- Monetary values use integer minor units plus ISO currency; floating-point arithmetic is prohibited.
- Date inventory uses an unambiguous property-local date and explicit check-in/check-out semantics.
- A booking is immutable in commercial intent after confirmation; amendments and cancellations create traceable state changes.
- Supplier confirmations, payment events and webhooks are idempotent.
- Every mutable tenant-owned record carries `tenant_id`; supplier-owned data also carries `supplier_organization_id` where applicable.
- Soft-delete, archival and retention policies are domain-specific; finance and audit records are not casually deleted.

---

## 6. API and domain boundaries

### Shared packages

The target package responsibilities are:

- `@bedbanks/contracts` — typed routes, request/response DTOs, validation envelopes and error codes shared by API and clients.
- `@bedbanks/domain` — provider-neutral business types, state machines and domain invariants.
- `@bedbanks/money` and `@bedbanks/pricing` — deterministic pricing calculations in integer minor units.
- `@bedbanks/connectors/*` — provider adapters, credentials, mapping and transport clients.

Frontend code depends on contracts, never on Prisma models. The API maps contracts to domain commands/queries and persists through Prisma repositories or services. Connectors translate external formats at the edge.

### API conventions

- Version externally consumed APIs, e.g. `/v1`.
- Use a consistent success/error envelope with machine-readable codes and safe messages.
- Propagate a request/correlation ID through API, job and connector calls.
- Require idempotency keys for booking, cancellation and other externally effectful write operations.
- Paginate collections; use filtering and cursor pagination where scale requires it.
- Publish OpenAPI/Swagger from the API and maintain contract tests for important flows.
- Never return stack traces, secrets, raw provider payloads or cross-tenant identifiers to a browser client.

---

## 7. Security, tenancy and audit

### Authentication

Authentication uses opaque sessions. Cookies must be `Secure`, `HttpOnly`, `SameSite`-appropriate and scoped to the intended application/domain. The session table stores only a SHA-256 hash of the session token, expiry and revocation metadata. Passwords use a modern adaptive hash such as bcrypt with approved work factors.

### Authorization and tenancy

1. The API authenticates the user.
2. It resolves the active tenant/workspace from the server-validated session or explicit permitted selection.
3. It validates membership, role and permission for the requested action.
4. It applies tenant and organization filters to every query and mutation.
5. It records audit events for security- or commercially-sensitive changes.

Frontend route guards and disabled controls are usability aids only. They do not replace API authorization.

Target defence-in-depth includes PostgreSQL row-level security for `tenant_id` scoped data, introduced only after migration and operational review. RLS complements—never replaces—application authorization tests.

### Audit and privacy

Audit events should include actor, tenant, action, target, before/after summary where safe, request ID, timestamp and source. Do not store passwords, full payment credentials or excessive personal data in logs. Apply data minimization, retention schedules, export/delete workflows where legally required, and access controls to personal guest data.

---

## 8. Supply, pricing and booking lifecycle

### Supply ingestion and contract lifecycle

`supplier/channel manager → connector or extranet → validation → canonical mapping → review/approval → published contract + inventory`

- Supplier connections are configured with encrypted secret references; never plaintext credentials in source or browser configuration.
- Mapping converts supplier property, room, rate-plan, meal-plan, cancellation and tax rules into canonical models.
- Contracts are versioned, effective-dated and approved before activation.
- Inventory changes retain source, effective date, received time and correlation reference.

### Search and price lifecycle

`search request → eligible supply → availability → contract/rate rules → markup → tax/fee → buyer quote → recheck`

The search response must state whether an option is live, cached, on request, unavailable or failed. Quote expiry, cancellation terms, currency conversion basis and price breakdown must be explicit.

### Booking lifecycle

`recheck → prebook (where required) → idempotent booking command → provider confirmation → voucher → ledger → servicing/cancellation`

A booking is never treated as confirmed until a provider or owned-inventory confirmation policy is satisfied. Unknown provider outcomes become a controlled `pending investigation` state, not a guessed success or failure. Financial postings are append-only ledger events with reconciliation status.

---

## 9. Integration architecture

External systems are isolated behind connector adapters.

| Connector class | Examples | Required controls |
| --- | --- | --- |
| Hotel/DMC supply | XML, REST, channel manager | Credential vault, mapping, retries, idempotency, rate limits |
| Bedbank/wholesaler | Availability, booking, cancellation APIs | Normalized errors, recheck policy, provider references |
| Distribution/XML Out | Partner agencies, resellers | Tenant contract scope, inventory filtering, signed credentials |
| Payments | Wallet funding, invoices, regional gateways | Webhook signature validation, ledger reconciliation |
| Messaging | Email, SMS, notifications | Template governance, PII minimization, delivery audit |
| Observability | Logs, metrics, alerts | Correlation IDs, redaction, retention controls |

Connectors run synchronously only when necessary for the user journey. Imports, exports, retries, reconciliation and webhook processing should use durable background jobs with dead-letter handling and operator visibility.

---

## 10. Infrastructure and environments

### Target deployment

| Layer | Target |
| --- | --- |
| Web apps | Separate Vercel projects rooted at the relevant `apps/*` directory |
| API | Container/service deployment with private network access to data services |
| Primary database | Managed PostgreSQL/Aurora with backups, point-in-time recovery and migration gates |
| Cache / ephemeral coordination | Redis for rate-limit, cache and job coordination where required |
| Object storage | S3-compatible storage for supplier files, exports and vouchers |
| Jobs | Queue-based workers, e.g. SQS-compatible workflow, with retries and DLQ |
| Secrets | Managed secret store; no plaintext production secrets in repository or Vercel client variables |
| Monitoring | Centralized structured logs, metrics, traces, alerting and error tracking |

### Environment policy

Use isolated `local`, `development`, `staging` and `production` environments with separate databases, secrets and connector credentials. Production data must not be copied into lower environments without approved anonymization. Database migrations are reviewed, replayable from an empty database, backward-compatible during rolling deployment and verified before release.

---

## 11. Reliability, performance and observability

- Apply timeouts, bounded retries and circuit breakers to external providers.
- Cache only explicitly safe availability/content data; never show stale availability as confirmed inventory.
- Run database backups and test restoration regularly.
- Publish operational SLIs/SLOs for authentication, search latency, recheck success, booking completion, cancellation completion, connector health and job backlog.
- Capture structured logs with request ID, tenant-safe context and provider reference; redact credentials and personal data.
- Alert on booking unknown-outcome states, webhook failures, queue backlog, authentication anomalies, RLS/authorization denials and failed migrations.
- Test critical journeys with contract, integration and end-to-end tests—not only UI builds.

---

## 12. Engineering and release guardrails

Required repository checks include:

```sh
pnpm type-check
pnpm lint
pnpm test
pnpm check:contracts
pnpm check:no-float
pnpm check:no-silent-fallback
pnpm check:schema
pnpm check:architecture
```

Before production release, additionally verify:

1. Migration replay and schema diff against a disposable PostgreSQL database.
2. Tenant-isolation and RBAC tests for every privileged or tenant-scoped route.
3. A live-safe provider sandbox path for search, recheck, booking and cancellation.
4. Booking idempotency, unknown-outcome and reconciliation scenarios.
5. Secret scanning, dependency review, security headers and accessible frontend smoke tests.
6. Monitoring dashboards, alerts, rollback plan and accountable on-call ownership.
7. Legal review for privacy, terms, supplier contracts, payments and regional compliance.

No application is production-booking ready merely because its UI builds successfully.

---

## 13. Delivery sequence

1. **Foundation hardening** — reconcile Prisma/migrations, contracts and CI guardrails; complete tenant/RBAC/audit enforcement.
2. **Canonical supply** — destination, supplier, property, room, contract, rate-plan and inventory model.
3. **Commercial engine** — markups, commission, taxes/fees, currency and explainable price breakdown.
4. **Search and recheck** — provider-neutral orchestration, caching policy and honest unavailable states.
5. **Transactional booking** — prebook, idempotent booking, vouchers, cancellation and exception handling.
6. **Finance and settlement** — wallets/credit, append-only ledger, invoices, reconciliation and approvals.
7. **Supplier and partner integration** — connector registry, extranet workflows, XML/REST distribution and monitoring.
8. **Scale and assurance** — RLS defence-in-depth, job workers, performance testing, disaster recovery and operational maturity.

## 14. Non-negotiable architecture rules

- Keep fBeds fully separate from UAEWB code, data, credentials, deployment and documentation.
- Never claim mock, seeded or unavailable supplier data is live.
- Never allow a client application to bypass API tenancy, RBAC, audit or pricing controls.
- Never use floating-point values for money.
- Never merge provider-specific models into the core travel domain.
- Never deploy destructive data changes without a reviewed, tested migration and rollback/forward-fix plan.
- Never treat UI completion as evidence of transactional, financial or supplier-integration readiness.

See [README](README.md), [local setup](docs/LOCAL_SETUP.md), [migration gates](apps/api/prisma/MIGRATIONS.md), and the [repository constitution](CLAUDE.md) for operational detail.
