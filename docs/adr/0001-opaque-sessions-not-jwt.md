# 0001: Opaque sessions, not JWT

## Status
Accepted.

## Decision
Use random, database-backed opaque session tokens in Secure, HttpOnly, SameSite cookies. Store only a SHA-256 token hash in PostgreSQL.

## Consequences
Sessions can be revoked immediately and no browser JavaScript accesses raw tokens. This requires a database lookup per authenticated request.
