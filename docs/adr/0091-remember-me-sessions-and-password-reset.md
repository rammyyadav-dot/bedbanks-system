# ADR 0091: Remember-me sessions, password reset and the sign-in Home link

Status: Proposed (2026-10-25). Part 1 (remember me) and Part 3 (Home link) are implemented. Part 2 (password reset) is a design only: nothing in it is built, and no UI offers it.

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

## Part 2: Forgot password (design only, not built)

### Why it is not built

The workflow needs two things the repository does not have and that are the owner's call: an email delivery provider (and a verified sending domain), and a reviewed Prisma migration with rollback notes. Shipping a "Forgot your password?" link without them would present a placeholder as a production capability (CLAUDE.md invariant 10). The link therefore stays off.

### Workflow

1. **Request.** `POST /auth/password-reset/request` with `{ email }`. The response is always `202` with the same body and similar timing, whether or not the account exists, is suspended, or has no password. This prevents account enumeration.
2. **Issue.** For an `ACTIVE` user with a password: create a single-use token (32 random bytes, hex), store only its SHA-256 hash in `password_reset_tokens`, expiry 30 minutes. Any earlier unused token for that user is superseded.
3. **Deliver.** Hand the link `<portal origin>/reset-password?token=…` to an `EmailPort` (provider adapter, outbound only). Delivery failure is logged with a code only (never the address or token) and does not change the response.
4. **Throttle.** Reuse the `LoginThrottle` pattern: 3 requests per account and 20 per address per 15 minutes. A throttled request still returns `202`.
5. **Complete.** `POST /auth/password-reset/confirm` with `{ token, newPassword }`. In one transaction: verify the token hash is unused and unexpired, apply the password policy, write the new bcrypt hash, mark the token used, **revoke every session of that user**, and write the audit event.
6. **After reset.** The user signs in again. No session is created by the reset itself.
7. **Audit.** `auth.password_reset.requested`, `.completed`, `.failed` as tenantless auth audit events with a reason code and no PII or token.
8. **Idempotency.** `confirm` is naturally single-use (second use fails). `request` is safe to repeat.

### Data model (needs review before migration)

```
password_reset_tokens(id, user_id → users ON DELETE CASCADE, token_hash UNIQUE, expires_at, used_at NULL, created_at)
INDEX (user_id), INDEX (expires_at)
```

Tenant-index review: the table is user-scoped, not tenant-scoped, like `sessions`, so it needs the same tenantless handling under RLS (an `app.auth_audit`-style flag policy). Rollback: drop the table; no existing table changes.

### Decisions the owner must make before this is built

- Email provider and sending domain (SES is the likely fit with the AWS setup, but that is not decided here).
- Password policy (the API currently only requires a non-empty password at login; `newPassword` needs a minimum length and a breached-password stance).
- Whether suspended users should be told nothing (recommended) or directed to support.

When these are decided, the supplier UI adds the link and two pages, gated on the API reporting the capability as enabled.

## Part 3: Home link (implemented)

The sign-in card shows "Home" only when `FABBEDS_HOME_URL` is set to an absolute `https:` URL (plain `http:` is accepted outside production). An unset or invalid value hides the link. The value is server-only and is not a `NEXT_PUBLIC_` variable.
