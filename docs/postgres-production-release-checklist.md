# PostgreSQL production release checklist

**Status as of 2026-09-18:** **GO for the controlled evidence-readiness sprint only.** Production deployment and booking remain disabled. No production, staging or shared database was accessed for this review.

**Sprint target decision date:** 2026-10-15.  
**Secure evidence location:** TBD by Product/CEO; do not record the location itself in GitHub.  
**Maintenance, escalation and release communication process:** TBD by Product/CEO, Database Owner and Engineering Lead.

Record secure evidence references only. Do not place credentials, connection strings, backup identifiers, customer data or sensitive query output in GitHub.

| Gate | Accountable role | Evidence target date | Date/time recorded | Secure evidence reference | Pass/fail | Remediation owner |
|---|---|---|---|---|---|---|
| Production `_prisma_migrations` matches the committed five-migration chain | Database Owner (TBD) | 2026-10-01 | Pending | Not supplied | **Missing** | Database Owner |
| Backup and isolated restore drill completed, including recovery duration/verification | Database Owner (TBD) | 2026-10-01 | Pending | Not supplied | **Missing** | Database Owner |
| PostgreSQL engine, version, extensions, encryption and approved baseline confirmed | Database Owner (TBD) | 2026-10-01 | Pending | Not supplied | **Missing** | Database Owner |
| Migration owner separated from HTTP application access | Database Owner / Security Lead (TBD) | 2026-10-08 | Pending | Not supplied | **Missing** | Database Owner |
| Non-owner HTTP role has no ownership, superuser or `BYPASSRLS` | Database Owner / Security Lead (TBD) | 2026-10-08 | Pending | Not supplied | **Missing** | Database Owner |
| Restricted background/system role is controlled and audited; operational/audit role is least-privilege read-only | Database Owner / Security Lead (TBD) | 2026-10-08 | Pending | Not supplied | **Missing** | Security Lead |
| Production RLS Tenant A/B negative verification, missing-context denial, and ledger/audit protection completed | Database Owner / Security Lead (TBD) | 2026-10-08 | Pending | Not supplied | **Missing** | Database Owner |
| Connection pool transaction-local context and reset behaviour reviewed | Database Owner / Engineering Lead (TBD) | 2026-10-08 | Pending | Not supplied | **Missing** | Engineering Lead |
| Credentials only in approved secret manager, rotation ownership, monitoring, access audit, maintenance window, rollback and forward-fix owners confirmed | Security Lead / Engineering Lead / Database Owner (TBD) | 2026-10-15 | Pending | Not supplied | **Missing** | Security Lead |

## Required sign-off

| Signatory | Assigned person | Sign-off date/time | Decision | Secure evidence reference |
|---|---|---|---|---|
| Database Owner | TBD by Product/CEO | Pending | Pending | Not supplied |
| Security Lead | TBD by Product/CEO | Pending | Pending | Not supplied |
| Engineering Lead | TBD by Product/CEO | Pending | Pending | Not supplied |
| Product / CEO | TBD | Pending | Pending | Not supplied |

A production release may proceed only when every gate is **Passed**, the secure evidence references are recorded, no unapproved exception remains, and all four signatories approve the final GO decision. Until then, production booking must remain disabled.
