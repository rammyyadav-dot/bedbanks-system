# ADR 0092: Agent access request intake

Status: Proposed (2026-10-25). Only the interim email composer (Decision 1) is implemented.

## Context

`/access` in the agent portal told visitors to email `hello@fbeds.com`. The WebBeds "Travel Buyers - Join Us" form shows the expected shape of a trade intake: company information, business type, connectivity type, comments, consent, then partnerships team review. The platform has `Agency`, `AgencyMember` and invite-style password setup (ADR 0091), but no application model, review queue, public intake endpoint or reviewer UI. The marketing site has a signed lead adapter that needs an external receiver.

## Decisions

1. **Interim (implemented).** The page collects the WebBeds-style fields, validates them in the browser and opens the visitor's own email client. Nothing is transmitted or stored by fBeds. The page states plainly that it is not submitted online.
2. **Target (proposed).** A first-party `AgencyApplication` aggregate with the state machine in `docs/agent-access-request-workflow.md`. Applications never create credentials. Provisioning is a separate approved step.
3. **Human approval only.** No automatic approval. Approve and provision are separate permissions.
4. **Email verification before review**, single-use hashed token, 24 hour expiry.
5. **Booking and credit start disabled** after activation. Finance enables them per agency.
6. **No published SLA** until measured.
7. **Public intake is tenant-resolved server-side**, idempotent and rate-limited. Contracts go in `@bedbanks/contracts` first.

## Alternatives considered

- Reuse the website lead adapter: rejected as the system of record because it only forwards to an external endpoint and has no state, audit or reviewer workflow.
- Auto-approve verified domains: rejected. A domain proves email control, not trade legitimacy or sanctions status.

## Consequences

Real intake needs a Prisma migration (rollback notes, tenant-index review), an API module, an admin review queue, an email template and a retention policy decided with legal. Until then the page must keep saying online submission is not configured.

## Open questions

Retention period; rate-limit values; which accreditations count per market; who owns the review queue and its internal first-response target.
