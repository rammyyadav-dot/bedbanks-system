# PostgreSQL production release checklist

**Status as of 2026-09-18:** **NO-GO.** No production, staging or shared database was accessed for this review. This is an evidence template, not approval.

Record secure evidence references only. Do not place credentials, connection strings, backup identifiers, customer data or sensitive query output in GitHub.

| Gate | Required owner | Date/time | Secure evidence reference | Pass/fail | Remediation owner |
|---|---|---|---|---|---|
| Production `_prisma_migrations` matches the committed five-migration chain | Database Owner | Pending | Not supplied | **Missing** | Database Owner |
| Backup and isolated restore drill completed | Database Owner | Pending | Not supplied | **Missing** | Database Owner |
| PostgreSQL engine, version, extensions, encryption and approved baseline confirmed | Database Owner | Pending | Not supplied | **Missing** | Database Owner |
| Non-owner HTTP role has no ownership, superuser or `BYPASSRLS` | Database Owner / Security Lead | Pending | Not supplied | **Missing** | Database Owner |
| Production RLS Tenant A/B negative verification completed | Database Owner / Security Lead | Pending | Not supplied | **Missing** | Database Owner |
| Connection pool transaction-local context and reset behaviour reviewed | Database Owner / Engineering Lead | Pending | Not supplied | **Missing** | Engineering Lead |
| Credentials only in approved secret manager; rotation ownership confirmed | Security Lead | Pending | Not supplied | **Missing** | Security Lead |
| Availability, backup, authentication, migration and access-audit monitoring enabled | Database Owner / Security Lead | Pending | Not supplied | **Missing** | Database Owner |
| Maintenance window plus rollback and forward-fix owners assigned | Engineering Lead / Database Owner | Pending | Not supplied | **Missing** | Engineering Lead |

A production release may proceed only when every row is **Passed**, the secure evidence references are recorded, and Database Owner, Security Lead, Engineering Lead and Product/CEO sign the go/no-go decision.
