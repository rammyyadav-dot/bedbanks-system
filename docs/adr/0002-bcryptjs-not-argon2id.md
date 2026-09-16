# 0002: bcryptjs for the current password implementation

## Status
Accepted with review required before production scale.

## Decision
Use bcryptjs at cost 12 while the deployment environment lacks a reliable native Argon2id installation path.

## Consequences
Password hashing remains portable. Evaluate Argon2id when CI and runtime binary supply are established.
