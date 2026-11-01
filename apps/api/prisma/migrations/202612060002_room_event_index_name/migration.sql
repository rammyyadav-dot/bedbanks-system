-- ADR 0089: align a RoomEvent index name with what Prisma derives, so migration drift detection is clean.
--
-- 202612050002_room_event_master created "RoomEvent_tenant_id_destination_city_event_start_date_event_end_date_idx" (72 characters). PostgreSQL silently
-- truncates identifiers to 63, leaving "..._event_end"; Prisma derives "..._event_idx" for the same @@index and reports the difference as drift
-- (prisma:migrate:drift, CI "Prisma migration certification"). Additive on purpose: the earlier migration is left byte-for-byte unchanged, so this is
-- safe whether or not it has already been applied to a database.
--
-- Tenant-index review: a rename only. The index, its columns (tenant_id, destination_city, event_start_date, event_end_date) and its tenant_id lead
-- column are unchanged, as is the planner's use of it for the dashboard/calendar views.
--
-- Rollback: ALTER INDEX IF EXISTS "RoomEvent_tenant_id_destination_city_event_start_date_event_idx" RENAME TO "RoomEvent_tenant_id_destination_city_event_start_date_event_end";
-- (a rename is metadata-only and takes no table rewrite; the rolled-back name reintroduces the drift reported above).

ALTER INDEX IF EXISTS "RoomEvent_tenant_id_destination_city_event_start_date_event_end" RENAME TO "RoomEvent_tenant_id_destination_city_event_start_date_event_idx";
