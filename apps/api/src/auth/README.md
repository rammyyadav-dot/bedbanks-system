# FBEDS API — Authentication (P0-D)

Opaque, database-backed sessions — not JWT. Two decisions worth recording:

## Why opaque sessions, not JWT

Per the CTO directive for this phase: immediate revocation (kill a
session and it's dead everywhere, no waiting for a token to expire),
no refresh-token architecture needed yet, and a much simpler mental
model for reasoning about "is this request actually authenticated"
when most of the system is still being built by AI-assisted, non-expert
review. JWT can be evaluated later if FBEDS grows external API/client
requirements that need stateless verification.

## Why bcryptjs instead of Argon2id

The spec's preferred choice is Argon2id, with explicit permission to
use "an appropriate well-maintained alternative" if the runtime makes
Argon2 operationally unsuitable, as long as the decision is documented
— this is that documentation.

`argon2` (the standard Node package) ships a compiled native binary,
fetched from a CDN at install time. This repo already hit exactly that
class of problem with Prisma's schema-engine binary (also
network-fetched, also blocked in the sandbox this was built in) — a
second native-binary dependency would hit the identical wall. bcryptjs
is pure JavaScript, no compiled binary, nothing to download at install
time. It was also already in use from the (now-superseded) JWT-based
P0-D pass, so this isn't a new dependency being introduced without
precedent.

If a future environment has reliable access to Argon2's binary CDN and
the team wants Argon2id's stronger memory-hardness guarantees, this is
a contained swap: `AuthService`'s `hashPassword`/`verifyPassword`
methods are the only places bcrypt is called.

## What's NOT enforced yet

Tenant isolation (P0-E) and RBAC (P0-F). `GET /auth/me` returns every
active membership the authenticated user has — nothing yet restricts
which tenant's data a request can touch. Every route built after this
phase that reads/writes tenant-scoped data needs an explicit tenant
guard before it can be trusted; that guard doesn't exist yet.
