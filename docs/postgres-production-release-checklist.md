# PostgreSQL production release checklist

This evidence template must be completed by the database owner. It is not proof of approval by itself.

| Gate | Owner evidence | Sign-off |
|---|---|---|
| `_prisma_migrations` matches the committed chain | Attach query output and release SHA | Pending |
| Backup and restore drill | Backup ID, restore time and verification | Pending |
| Engine, version and extensions | Approved PostgreSQL version/configuration | Pending |
| Non-owner HTTP role | No table ownership or `BYPASSRLS`; RLS tests recorded | Pending |
| RLS policies | Tenant A/B read and write negative tests | Pending |
| Connection pool | Transaction-local context and reset behaviour reviewed | Pending |
| Secrets | Stored only in approved secret manager | Pending |
| Monitoring and access audit | Alerts and database access logging enabled | Pending |
| Maintenance window | Window, forward-fix owner and rollback owner assigned | Pending |
