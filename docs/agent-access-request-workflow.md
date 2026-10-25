# Request Agent Access: workflow, business rules and logic

Status: **Specification.** Part 1 is implemented in `apps/agent` (`/access`). Parts 2 to 6 are the target design for a real intake and are **not implemented**. Nothing in Parts 2 to 6 may be shown to users as a live capability until it ships (CLAUDE.md invariant 10). Decision record: `docs/adr/0092-agent-access-request-intake.md`.

Reference: the WebBeds "Travel Buyers - Join Us" form (`webbeds.com/forms/buyer-join-us/`). We copy its **shape** (company information, business and connectivity type, comments, consent, review by a partnerships team). We do not copy its brand, imagery, volume statistics or supplier counts.

## 1. What ships today (Part 1)

| Area | Behaviour |
|---|---|
| Route | `GET /access` in the agent portal. Public, no session. |
| Layout | Brand header and Agent Sign In, breadcrumb, headline, four-step "How a request works", agency form with a "Before you apply" sidebar, supplier redirect note, shared footer. fabBeds red `#D90429`, white and `#F7F8FA` surfaces, rounded 8 px fields, 20 to 24 px cards. |
| Form | Agency and contact fields modelled on the WebBeds buyer form (see section 3). Validated in the browser by `lib/access-request.ts`. |
| Submit | **Opens the visitor's own email client** addressed to `hello@fbeds.com` with the details filled in, then shows the same text to copy. No network call, no storage, no cookie. |
| Honesty | The page says online submission is not configured, that sending is the visitor's step, and that nothing is active until the team sets it up. No turnaround time, approval rate or volume claim is published. |

Why email and not a form post: the portal has no receiver, queue or reviewer UI. A form that appeared to submit would be a placeholder presented as production (invariant 10). The marketing site's signed lead adapter (`apps/website/lib/leads`) is the only existing receiver pattern and requires `FBEDS_LEAD_ENDPOINT_URL` plus a signing secret.

## 2. Target workflow (not implemented)

```
Visitor ─► Intake form ─► [SUBMITTED] ─► Automated checks ─► [IN_REVIEW]
                                              │                   │
                                              ▼                   ├─► [INFO_REQUESTED] ─► applicant replies ─► [IN_REVIEW]
                                      [REJECTED_AUTO]             ├─► [APPROVED] ─► Provisioning ─► [ACTIVATED]
                                      (spam / blocked)            ├─► [DECLINED]
                                                                  └─► [WITHDRAWN] / [EXPIRED]
```

### 2.1 States and transitions

| State | Meaning | Allowed next | Who can cause it |
|---|---|---|---|
| SUBMITTED | Received and stored. No access. | IN_REVIEW, REJECTED_AUTO | System |
| IN_REVIEW | Owned by a reviewer. | INFO_REQUESTED, APPROVED, DECLINED | Reviewer with `agency_application.review` |
| INFO_REQUESTED | Waiting for the applicant. | IN_REVIEW, WITHDRAWN, EXPIRED | Reviewer, applicant, system timer |
| APPROVED | Decision made. No login exists yet. | ACTIVATED | Reviewer with `agency_application.approve` (not the same person who created the application, where staff-entered) |
| ACTIVATED | Agency and first user exist, invite sent. Terminal. | none | System, after provisioning succeeds |
| DECLINED | Terminal. Reason code recorded. | none (a new application is a new record) | Approver |
| REJECTED_AUTO | Honeypot, rate limit or sanctions or blocklist hit. Terminal. | none | System |
| WITHDRAWN, EXPIRED | Terminal. | none | Applicant, timer |

No transition skips a state. Every transition writes an audit event (invariant 8) with actor, from, to and reason code. No state change is possible by calling the public endpoint twice.

### 2.2 Step by step

1. **Intake.** Public endpoint `POST /public/agent-applications`. Tenant is resolved server-side from the deployment, never from the body (invariant 1). Idempotency key required (invariant 6): the form generates one per page load, so a double-click or retry returns the original reference.
2. **Automated checks (synchronous, cheap).** Honeypot field, per-IP and per-email rate limit, payload size limit, field validation (section 4), disposable and consumer mailbox rejection, blocklist match on domain or company number.
3. **Email verification.** A single-use link, token stored hashed (SHA-256), valid 24 hours, sent to the work email. The application does not enter IN_REVIEW until verified. This proves the applicant controls the domain they claim.
4. **Triage.** Review queue sorted oldest first. Reviewer claims an item (soft lock, released after inactivity).
5. **Due diligence checklist** (reviewer ticks each, with notes):
   - Company exists in the stated country and number matches the registry or licence.
   - Trade licence or accreditation seen (IATA, ABTA, ATOL, DTCM or the local equivalent), where the market has one.
   - Website matches company name, and work email domain matches the website.
   - Sanctions and restricted-country screening result recorded.
   - Business type and connectivity are supported (section 5).
   - No duplicate agency (same company number, domain, or email domain already registered).
6. **Decision.** Approve, decline with a reason code, or request information (free text sent by email, applicant replies by link).
7. **Provisioning (on approve).** In one transaction: create `Agency` (status `ACTIVE`, or `PENDING` until credit terms are set), create the first `User` as agency admin, create `AgencyMember`, assign the least-privilege agent role, then send a single-use set-password invite (ADR 0091 reset mechanics). Booking stays **disabled** until finance enables it per agency. Credit limit starts at zero.
8. **Notification.** Applicant receives a neutral status email at each of: verified, info requested, approved, declined. Decline emails never state risk or sanctions reasons.
9. **Retention.** Declined, withdrawn and expired applications are purged or anonymised after the retention period decided with legal. Approved applications keep the diligence record with the agency.

## 3. Form fields (mirrors the WebBeds buyer form)

| Field | Required | Notes |
|---|---|---|
| First name, last name | Yes | |
| Job title | Yes | |
| Agency or company name | Yes | Max 160 |
| Work email, repeat work email | Yes | Must match. Consumer and disposable domains rejected. |
| Business phone | Yes | Country code expected |
| Country the company is registered in | Yes | Becomes an ISO-3166 alpha-2 select in the real intake |
| Business type | Yes | Leisure travel agent, corporate travel agent, DMC or groups, OTA, wholesaler or reseller, other (with free text) |
| Connectivity type | Yes | Booking website, API or XML, both |
| Company website | No | Domain compared with the email domain |
| Registered company number | No at intake, required before approval | |
| Estimated monthly room nights | Yes | Band, used for triage only, never for pricing |
| Comments | No | Max 1,500. Warned not to include secrets or guest data. |
| Consent | Yes | Purpose-limited: review and contact about this request |

WebBeds fields deliberately **not** copied: "Region you are based" (derived from country), a separate mobile number (one business phone is enough for triage).

## 4. Business rules

1. **Access is never automatic.** No rule, score or timer approves an agency. A human with the approve permission decides.
2. **Application is not an account.** An application has no credentials, session or role. Only provisioning creates them.
3. **One agency per verified domain.** A second application from a registered domain is routed to the existing agency admin, not a new agency.
4. **Work email only.** Consumer, disposable and role mailboxes (`info@`, `sales@`) are accepted only at reviewer discretion with a note.
5. **Supplier requests are out of scope.** Hotels and suppliers are redirected to the supplier onboarding path. Misrouted applications can be re-typed by a reviewer, not silently dropped.
6. **Sanctions and restricted markets** are screened before APPROVED. A hit blocks approval and requires compliance sign-off.
7. **Money.** Credit limit and settlement currency are set at provisioning by finance in integer minor units with an ISO-4217 code (invariant 3). The applicant's volume band never feeds a credit decision.
8. **Idempotency.** Same idempotency key and same payload returns the original reference. Same key and different payload returns a conflict.
9. **Rate limits.** Defaults to confirm in the ADR: 5 submissions per IP per hour, 3 per email per day, 1 verification email per application per 5 minutes.
10. **SLA is internal.** A target first-response time may be set for the review queue and alerted on, but is **never published** on the page until the team measures and agrees to it.
11. **Logging.** Log reason codes and application ids only. Never log the form body, email, phone, tokens or raw payloads (invariant 7).
12. **Permissions.** Intake is public. Every reviewer endpoint is tenant-scoped and declares a permission: `agency_application.read`, `.review`, `.approve`, `.provision`. Authentication alone is not enough (invariant 2).
13. **Audit.** Every transition, claim, checklist change, decision and provisioning writes an immutable audit event (invariant 8).
14. **Canonical types.** Contracts live in `@bedbanks/contracts` before the portal or admin consume them (invariant 4).

## 5. Capability and connectivity rules

| Applicant chooses | Outcome |
|---|---|
| Booking website | Agent portal user. Search and recheck today (Dubai pilot). Booking only after finance enables it. |
| API or XML | Distribution client credentials issued separately after approval, stored as secret references, shown once. Needs technical review and IP allow-list. Not part of first provisioning. |
| Both | Portal first, API after technical review. |

## 6. Data model sketch (needs a reviewed Prisma migration, rollback notes and a tenant-index review)

`AgencyApplication`: `id`, `tenantId`, `reference`, `status`, `idempotencyKey` (unique per tenant), `legalName`, `countryCode`, `agencyType`, `connectivity`, `websiteDomain`, `registrationNumber`, `volumeBand`, `contactName`, `jobTitle`, `workEmail` (encrypted), `phone` (encrypted), `comments`, `emailVerifiedAt`, `reviewerId`, `decisionReason`, `agencyId` (set on activation), timestamps. Indexes: `(tenantId, status, createdAt)`, `(tenantId, websiteDomain)`, unique `(tenantId, idempotencyKey)`.
Related: `AgencyApplicationEvent` (append-only), `AgencyApplicationCheck` (diligence ticks), `AgencyApplicationVerification` (hashed token, expiry, used at).

## 7. Metrics (when real)

Applications by status and age, time to first reviewer action, verification completion rate, approval and decline rate by reason, time to activation, first search within 14 days of activation, duplicate-domain hits. Report medians and counts, never publish them as marketing claims without sign-off.

## 8. Acceptance for the real intake

- Contract in `@bedbanks/contracts`, API module with permission checks, migration with rollback notes.
- Idempotency, rate-limit and honeypot tests. No-enumeration test for email verification.
- Reviewer UI in admin, with the audit trail visible.
- Page copy changed from "online submission is not configured" only after an end-to-end test against a real receiver.
- `pnpm check:architecture`, `pnpm type-check`, `pnpm lint`, `pnpm test` and affected builds pass.
