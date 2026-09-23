# ADR 0004: Supplier mapping identity governance

Supplier-native hotel and room IDs are scoped by supplier identities; neither
is a canonical fBeds Hotel or RoomType ID. One supplier hotel code maps to one
canonical hotel, and one supplier may map a canonical hotel only once in this
milestone. Multiple supplier room codes may resolve to one canonical RoomType.

PostgreSQL composite keys enforce mapping tenant = Supplier tenant = Hotel
tenant. SupplierRoomMapping carries `hotel_id` to allow composite FKs that
enforce its parent mapping and canonical RoomType refer to the same Hotel.
Its tenant must match the parent. Prisma represents these composite relations;
the forward-only migration additionally owns nonblank ID and confidence CHECKs
and RLS policies, which Prisma cannot fully model.

RLS is forced on both mapping tables and evaluated through transaction-local
tenant context. The NestJS mapping service checks dedicated permissions and
performs each successful mutation with its AuditEvent in one transaction.
`PENDING` may be approved or rejected; only an explicit reopen action may
move `MAPPED` or `REJECTED` back to `PENDING`.

Deployment requires a read-only preflight of existing rows in each relevant
database, a fresh replay, restricted-role RLS certification, and reviewed
evidence. The SQL migration also fails before DDL when incompatible mapping
rows exist. The migration cannot automatically repair data. Rollback is a
controlled forward migration after reviewing mappings and dependents; do not
drop the new table or constraints automatically in a live database.
The preflight script rejects a session subject to RLS on the inspected tables:
a tenant-scoped zero-row result would not certify all tenants. Its audit role
must have complete read visibility but no write grants, approved by the
database owner.
