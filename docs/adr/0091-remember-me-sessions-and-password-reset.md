# ADR 0091: Remember-me sessions, password reset and the sign-in Home link

Status: Accepted (2026-10-25). All three parts are implemented. Password reset stays off in any deployment until `email_from` and `ses_identity_arn` are set.

## Context

The supplier extranet sign-in was redesigned to match the fabBeds brand and the WebBeds reference. The reference offers "Remember me for 15 days", "Forgot your password?" and "Home". The API has opaque, database-backed sessions (`sessions.expires_at`, one fixed `AUTH_SESSION_TTL_SECONDS`, default 8 hours), a failed-login throttle, and tenantless auth audit events. It has no outbound email capability and no password-reset model.

## Part 1: Remember me (implemented)

### Rules

1. **Opt-in only.** `POST /auth/login` accepts an optional boolean `rememberMe`. Absent or `false` keeps the standard session. The checkbox is unticked by default and carries the warning "Only select on your trusted personal device".
2. **Fixed window, never sliding.** A remembered session lives `AUTH_REMEMBER_TTL_SECONDS` (default 1 296 000 s = 15 days) from sign-in. `validateSession` never extends `expires_at`, so activity cannot stretch it.
3. **Bounded whatever the environment says.** The effective window is clamped to at least the standard session lifetime and at most 30 days.
4. **Same revocation as any session.** Logout revokes it. Suspending the user, or a user whose status is not `ACTIVE`, invalidates it on the next request, because the user status is checked on every request.
5. **Only a successful login can grant it.** A rejected login (wrong password, unknown user, suspended user, throttled) creates no session and returns the same generic error whether or not `rememberMe` was sent.
6. **Cookie matches the row.** The `Set-Cookie` `Max-Age` is the same TTL that was written to `sessions.expires_at`. The supplier portal copies the API cookie's attributes, so no portal-side lifetime is invented.
7. **Observable.** The `auth.login.success` audit payload gains `remembered: true|false`. No token, email or password is logged.
8. **No schema change.** The existing `sessions.expires_at` column carries the longer window, so there is no migration.

### Consequences

Every portal that signs in through `/auth/login` can send `rememberMe`. Only the supplier extranet does today. Admin and agent are unchanged until they opt in.

## Part 2: Forgot password (implemented, off until email is configured)

### Decisions (settled 2026-10-25)

- **Provider:** AWS SES v2, through the existing `SesEmailSender` and `EMAIL_FROM` / `EMAIL_SES_REGION` (ADR 0066). Credentials come from the API task role; none are stored.
- **Password policy for a new password:** 12 to 128 characters, not the user's email or a name derived from it, not a repeated pattern, not an obvious common word. No composition rules and no breached-password lookup (that needs an outbound service the platform does not have).
- **Suspended, unknown and passwordless accounts** get the same answer as everyone else and no email.

### Business rules

1. **Off unless real.** `GET /auth/capabilities` reports `passwordReset: true` only when a sender and `EMAIL_FROM` are configured **and** `PASSWORD_RESET_ORIGINS` names at least one portal. The sign-in page shows "Forgot your password?" only then. The `/forgot-password` and `/reset-password` pages say "unavailable" otherwise.
2. **No enumeration.** `POST /auth/password-reset/request` always answers `202 { accepted: true }`. The work (lookup, token, email) is not awaited, so neither the body nor the timing depends on whether the account exists.
3. **Link origin is never trusted from the caller.** The link is built from the request `Origin` only if it is exactly one of `PASSWORD_RESET_ORIGINS`; any other origin does nothing. (`OriginGuard` already rejects untrusted origins on every mutation.)
4. **Token.** 32 random bytes (hex). Only its SHA-256 is stored in `password_reset_tokens`. Valid 30 minutes and once. A new request supersedes earlier unused links (stamps their `used_at`).
5. **Throttle.** Every request counts: 3 per account per address and 20 per address, per 15 minutes. A throttled request still answers `202` (no email, `Retry-After` set).
6. **Confirm.** `POST /auth/password-reset/confirm` with `{ token, newPassword }`. In one transaction: claim the token (`used_at` set only if still unused and unexpired), write the new bcrypt hash, **revoke every session of the user**. A lost race changes nothing. A weak password is refused with `422 WEAK_PASSWORD` **without** consuming the token. An invalid, used, expired or suspended-user token is `400 RESET_TOKEN_INVALID`.
7. **No automatic sign-in.** After a reset the user signs in again.
8. **Audit.** `auth.password_reset.requested` (outcome `sent`, `delivery_failed` or `ignored`), `.completed`, `.failed` (reason code). Tenantless auth events. No address, token or password is logged.
9. **Email.** Plain text plus HTML, no remote images or tracking. Delivery failures are logged as a code only.
10. **Idempotency.** Confirm is single-use by construction; request is safe to repeat.

### Data and privileges

`password_reset_tokens(id, token_hash UNIQUE, expires_at, used_at, created_at, user_id → users ON DELETE CASCADE)`, indexed on `user_id` and `expires_at`. User-scoped like `sessions`, so no tenant column and no RLS policy (listed in `RLS_EXEMPT_TABLES`). Migrations `202612070001_password_reset_tokens` (table) and `202612070002_strict_runtime_role_password_reset` (grants). Rollback: `DROP TABLE "password_reset_tokens"`; `REVOKE UPDATE ("password_hash") ON "users" FROM fbeds_api`.

The strict runtime contract grants `fbeds_api` exactly: `SELECT, INSERT` and `UPDATE ("used_at")` on `password_reset_tokens` (no DELETE), and `password_hash` added to the existing `UPDATE` column list on `users`. `docs/strict-runtime-db-role.md` is regenerated from the contract.

### Infrastructure

Terraform variables `email_from` and `ses_identity_arn` (both empty by default, which keeps reset off). When set, the API gets `EMAIL_FROM`, `EMAIL_SES_REGION` and `PASSWORD_RESET_ORIGINS` (the supplier host), and its task role gets one statement: `ses:SendEmail` on that identity. Operator steps: verify the SES identity, request SES production access (a sandbox account can only email verified addresses), then set the two variables and apply.

### Not covered

Admin and agent portals have no reset page; their origins are not in `PASSWORD_RESET_ORIGINS`, so a request from them does nothing. Email delivery could not be exercised against real SES from the build environment; the sender is unit-tested with a fake provider.

## Part 3: Home link (implemented)

The sign-in card shows "Home" only when `FABBEDS_HOME_URL` is set to an absolute `https:` URL (plain `http:` is accepted outside production). An unset or invalid value hides the link. The value is server-only and is not a `NEXT_PUBLIC_` variable.
