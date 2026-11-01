#!/usr/bin/env bash
# Grants the seeded owner role the permissions the blueprint check needs, and adds search audit events and a net amount. Disposable local database only.
set -euo pipefail
DB=${1:-fbeds_ci}
cd "$(dirname "$0")"
T=$(node -p "require('./.seed-hotels.json').tag"); A=$(node -p "require('./.seed-hotels.json').tenantA")
psql -q "$DB" <<SQL
INSERT INTO "Permission"("id","key","description") VALUES ('p_exp','supply.hotels.export','x'),('p_fin','finance.read','x'),('p_aud','audit.read','x') ON CONFLICT ("key") DO NOTHING;
INSERT INTO "RolePermission"("role_id","permission_id") SELECT r.id, p.id FROM "Role" r, "Permission" p WHERE r.name = 'owner-$T' AND p.key IN ('supply.hotels.export','finance.read','audit.read') ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent"("id","tenant_id","actor_type","action","entity_type","entity_id","payload") SELECT 'se$T'||g, '$A', 'SYSTEM','hotel.search','search','s'||g, ('{"status":"'||(ARRAY['available','no_availability','provider_unavailable'])[1+g%3]||'","destination":"Dubai","requestId":"r'||g||'"}')::jsonb FROM generate_series(1,6) g;
UPDATE "Booking" SET net_minor = 120000 WHERE reference = '$T-BK1';
SQL
