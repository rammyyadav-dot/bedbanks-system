# P0-D pre-implementation inspection (A–K)

Authoritative source: rammyyadav-dot/bedbanks-system, main commit e03f8d2d8cfbb34b7d068a3106039743172b2a34. Isolated branch: feat/p0-d-session-hardening. Inspection completed before implementation. The existing enterprise-target-structure branch is not the source.

## A. Exact tracked repository structure
See P0D-TRACKED-FILES.txt for every tracked path, including committed API dist files. Five apps: website, agent, admin, supplier, api. Shared packages: config, types, ui, validation. Root pnpm workspace/Turbo. Root scripts only target Admin. README is empty. No root AGENTS.md or CLAUDE.md at this commit.

## B. Current Prisma schema
The exact unmodified schema is appended below. Authoritative path: apps/api/prisma/schema.prisma. PostgreSQL, Prisma 6. Identity, sessions, formal tenant roles/permissions and agent domain models already exist. Schema comments claiming those models do not exist are stale.

## C. NestJS modules, controllers and services
- apps/api/src/agent/agent.controller.ts
- apps/api/src/agent/agent.module.ts
- apps/api/src/agent/audit.service.ts
- apps/api/src/agent/finance.service.ts
- apps/api/src/app.module.ts
- apps/api/src/auth/auth.controller.ts
- apps/api/src/auth/auth.module.ts
- apps/api/src/auth/auth.service.ts
- apps/api/src/database/database.module.ts
- apps/api/src/database/prisma.service.ts
- apps/api/src/health/health.controller.ts
- apps/api/src/health/health.module.ts

AppModule imports global ConfigModule, DatabaseModule, AuthModule, HealthModule, AgentModule. PrismaService connects on initialization. API bootstrap has cookie-parser, exact-origin credentialed CORS, DTO validation, response envelope and exception filter. AgentModule uses SessionAuthGuard but does not import AuthModule: test full module initialization, not only isolated auth.

## D. Admin structure
Next.js App Router. app/login, app/(dashboard)/layout.tsx, dashboard subpages, components/auth/LoginForm and LogoutButton, lib/auth/actions and session, lib/api/auth-client. Middleware checks cookie presence; dashboard layout calls API /auth/me. Exact paths are in the inventory.

Critical: server-side fetch does not forward Set-Cookie automatically. Login currently discards the header; logout never deletes the Admin cookie and swallows API revocation failures. Auth fetch is not explicitly no-store. Preserve the server-action architecture; explicitly set/delete the host-only cookie server-side. Raw tokens must never appear in action return values or client props.

## E. Existing environment variables
API: NODE_ENV, API_HOST, API_PORT, API_PREFIX, DATABASE_URL, AUTH_SESSION_TTL_SECONDS, AUTH_COOKIE_NAME, AUTH_COOKIE_SECURE, AUTH_COOKIE_SAME_SITE, ADMIN_ORIGIN. Seed: FBEDS_SEED_ADMIN_EMAIL, FBEDS_SEED_ADMIN_PASSWORD. Admin: NEXT_PUBLIC_API_URL, AUTH_COOKIE_NAME. These are names from code/templates, not secret values. API and Admin both default to port 3001, while ADMIN_ORIGIN defaults to 3000: correct API default to 3002 and Admin origin to 3001. Introduce server-only API_INTERNAL_URL and AUTH_API_ORIGIN for the Admin-to-API request path.

## F. Database configuration
PostgreSQL via DATABASE_URL. No live database credentials supplied for this task. Three migrations ALREADY exist (the earlier absence assumption is obsolete): baseline_identity, p0d_authentication, agent_domain_foundation. The third recreates Status, tenants, users, memberships and sessions from the first two; sequential deployment fails. No production database will be touched.

## G. Existing authentication
AuthService uses bcryptjs, 32-byte random hex tokens, SHA-256 tokenHash, absolute expiration, revokedAt, active-user checks and filtered memberships. /auth/login, /auth/me, /auth/logout already exist. No JWT needed. Gaps: invalid dummy bcrypt hash; missing malformed-token checks; insecure cookie defaults; no CSRF origin guard; no explicit no-store headers; no auth lifecycle tests. Preserve response envelope and existing safe identity shape.

## H. Roles and permissions
Membership.role legacy strings; Permission, Role (tenant-scoped), UserRole, RolePermission. AgentRbacGuard checks formal permissions with owner/finance legacy fallbacks. TenantContextGuard validates requested tenant against membership. Admin can() is a UI hint, not backend authorization. P0-D does not invent a platform-admin privilege model or claim P0-E complete.

## I. Exact intended create/change paths
Changes: apps/api/src/auth/{auth.controller.ts,auth.module.ts,auth.service.ts,utils/password.ts,utils/session-token.ts,dto/login.dto.ts}; apps/api/src/config/{configuration.ts,env.validation.ts}; apps/api/src/agent/agent.module.ts; apps/api/.env.example; apps/api/prisma/MIGRATIONS.md; apps/admin/lib/api/auth-client.ts; apps/admin/lib/auth/{actions.ts,session.ts}; apps/admin/.env.example.
Create: apps/api/src/auth/guards/origin.guard.ts; apps/api/src/auth/auth.service.spec.ts; apps/api/src/config/env.validation.spec.ts; apps/api/test/auth.e2e-spec.ts; apps/admin/lib/auth/actions.test.ts; docs/P0D-INSPECTION.md; docs/P0D-TRACKED-FILES.txt; docs/P0D-VALIDATION.md.
Test/lint configuration and package scripts may require narrowly documented additions after baseline command results. No schema change is planned. Existing migration SQL will not be silently rewritten without knowing deployment history.

## J. Migration strategy
Preserve the existing separate P0-C baseline and P0-D migration. First validate/generate current Prisma client; replay migrations only against a disposable PostgreSQL database. Check drift against the full schema with migrate diff. Do not use migrate dev, db push, reset, or mark unknown migrations applied. The conflicting third migration is a release blocker; if deployed elsewhere, reconcile its actual history before repairing. A later corrective migration cannot run past an earlier failing migration. Production deployment must remain blocked until that history is established.

## K. Test strategy and stages
1. Baseline: frozen dependency install, API/Admin typecheck, lint, API unit/e2e and Prisma validate. Report pre-existing failures separately.
2. API: verify hash-only persistence, entropy/format, login rejection, expiry boundary, revoked/suspended sessions, logout idempotency, cookie flags/clearing, DTOs, origin rejection, no-store and full Nest dependency injection. Validate/typecheck/lint/unit/integration after changes.
3. Admin: test explicit server-side cookie transfer and deletion, no token returned, no-store validation, failed login/logout and redirects. Typecheck/lint/build where dependencies permit; browser E2E only if actual runtime is available.
4. Database: replay and drift verification against disposable PostgreSQL; no passing claim for mocked database tests. Document all command results and blockers. Completion requires gates actually pass.

## Exact inspected Prisma schema

```prisma
// FBEDS — Prisma schema
//
// Scope discipline: identity + authentication foundation.
//   - Tenant, User, Membership — who exists and who belongs where (P0-C)
//   - Status (Tenant/User) — minimal lifecycle only: ACTIVE/SUSPENDED.
//     Not a general workflow state machine — don't overbuild this.
//   - User.passwordHash, User.lastLoginAt, Session — P0-D authentication.
//     Opaque, database-backed sessions, NOT JWT: the browser holds a
//     random token in an HttpOnly cookie; the database holds only a
//     SHA-256 hash of it (Session.tokenHash). This is a deliberate
//     architecture choice over JWT — see apps/api/src/auth/README.md
//     for the reasoning (immediate revocation, no refresh-token
//     complexity yet, simpler to reason about for this stage).
//   - Membership.role is a plain string for now (e.g. "owner", "member").
//     Formal roles/permissions tables are P0-F (RBAC) — don't confuse
//     the two.
//
// Explicitly NOT here yet: tenant row-level isolation policies (P0-E
// enforcement — the Session/Membership shape already supports it, but
// nothing enforces it yet), permissions (P0-F), audit log (P0-G), or
// any hotel/booking/wallet domain model (P1+).

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// Minimal lifecycle status shared by Tenant and User. Deliberately
/// just two states — a full workflow (PENDING, INVITED, ARCHIVED, ...)
/// is a later, explicit decision, not something to grow accidentally.
enum Status {
  ACTIVE
  SUSPENDED
}

enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
  FAILED
}

enum AuditActorType {
  USER
  SYSTEM
}

enum LedgerEntryType {
  CREDIT
  DEBIT
  HOLD
  RELEASE
  REFUND
}

model Tenant {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  status    Status   @default(ACTIVE)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  memberships Membership[]
  roles       Role[]
  bookings    Booking[]
  wallets     Wallet[]
  ledger      LedgerEntry[]
  auditEvents AuditEvent[]

  @@map("tenants")
}

model User {
  id           String    @id @default(cuid())
  email        String    @unique
  name         String?
  passwordHash String?   @map("password_hash")
  status       Status    @default(ACTIVE)
  lastLoginAt  DateTime? @map("last_login_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  memberships Membership[]
  sessions    Session[]
  roles       UserRole[]
  auditEvents AuditEvent[]

  @@map("users")
}

/// Links a User to a Tenant. `role` is a plain string placeholder for
/// P0-C — real role/permission modeling is P0-F, not here.
model Membership {
  id        String   @id @default(cuid())
  role      String   @default("member")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  userId String @map("user_id")
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  tenantId String @map("tenant_id")
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([userId, tenantId])
  @@index([tenantId])
  @@map("memberships")
}

/// Opaque, database-backed session (P0-D). The raw session token is
/// NEVER stored here — only SHA-256(token), in tokenHash. If this
/// table is ever compromised, the hashes alone can't be replayed as
/// valid session cookies. Deleting a User cascades to their sessions.
model Session {
  id         String    @id @default(cuid())
  tokenHash  String    @unique @map("token_hash")
  expiresAt  DateTime  @map("expires_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  lastSeenAt DateTime  @default(now()) @map("last_seen_at")
  revokedAt  DateTime? @map("revoked_at")

  userId String @map("user_id")
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
  @@map("sessions")
}

model Permission {
  id          String           @id @default(cuid())
  key         String           @unique
  description String?
  roles       RolePermission[]
}

model Role {
  id          String           @id @default(cuid())
  name        String
  tenantId    String           @map("tenant_id")
  tenant      Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  users       UserRole[]
  permissions RolePermission[]
  createdAt   DateTime         @default(now()) @map("created_at")

  @@unique([tenantId, name])
  @@index([tenantId])
}

model UserRole {
  userId String @map("user_id")
  roleId String @map("role_id")
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  role   Role   @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@id([userId, roleId])
}

model RolePermission {
  roleId       String     @map("role_id")
  permissionId String     @map("permission_id")
  role         Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@id([roleId, permissionId])
}

model Booking {
  id             String         @id @default(cuid())
  tenantId       String         @map("tenant_id")
  tenant         Tenant         @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  reference      String         @unique
  supplier       String
  hotelId        String         @map("hotel_id")
  status         BookingStatus  @default(PENDING)
  currency       String
  totalMinor     Int            @map("total_minor")
  idempotencyKey String         @unique @map("idempotency_key")
  searchSnapshot Json           @map("search_snapshot")
  createdAt      DateTime       @default(now()) @map("created_at")
  updatedAt      DateTime       @updatedAt @map("updated_at")
  cancellations  Cancellation[]

  @@index([tenantId, status])
}

model Cancellation {
  id          String   @id @default(cuid())
  bookingId   String   @map("booking_id")
  booking     Booking  @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  reason      String?
  refundMinor Int?     @map("refund_minor")
  createdAt   DateTime @default(now()) @map("created_at")
}

model Wallet {
  id          String        @id @default(cuid())
  tenantId    String        @unique @map("tenant_id")
  tenant      Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  currency    String        @default("USD")
  creditLimit Int           @default(0) @map("credit_limit")
  balance     Int           @default(0)
  createdAt   DateTime      @default(now()) @map("created_at")
  updatedAt   DateTime      @updatedAt @map("updated_at")
  entries     LedgerEntry[]
}

model LedgerEntry {
  id          String          @id @default(cuid())
  tenantId    String          @map("tenant_id")
  tenant      Tenant          @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  walletId    String          @map("wallet_id")
  wallet      Wallet          @relation(fields: [walletId], references: [id], onDelete: Restrict)
  type        LedgerEntryType
  amountMinor Int             @map("amount_minor")
  currency    String
  reference   String?
  immutableAt DateTime        @default(now()) @map("immutable_at")

  @@index([tenantId, immutableAt])
}

model AuditEvent {
  id         String         @id @default(cuid())
  tenantId   String?        @map("tenant_id")
  tenant     Tenant?        @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  userId     String?        @map("user_id")
  user       User?          @relation(fields: [userId], references: [id], onDelete: SetNull)
  actorType  AuditActorType @map("actor_type")
  action     String
  entityType String         @map("entity_type")
  entityId   String         @map("entity_id")
  payload    Json
  createdAt  DateTime       @default(now()) @map("created_at")

  @@index([tenantId, createdAt])
  @@index([entityType, entityId])
}

```

## Implementation path refinements after baseline checks

The baseline lint scripts failed because ESLint was not installed or configured. Added root eslint.config.mjs and root dev dependencies (package.json/pnpm-lock.yaml). Added API test scripts in apps/api/package.json. Admin tests live in apps/api/test/admin-auth.integration.ts with admin-auth.jest.cjs to reuse the existing Jest runner (instead of the initially proposed Admin test path). New Admin files: lib/api/errors.ts (client-safe errors) and lib/auth/session-cookie.ts (server-only cookie parsing). Updated lib/api/client.ts to import errors without pulling server-only code into client bundles. Updated API main.ts to align its fallback port with configuration. No Prisma schema/SQL changes.
