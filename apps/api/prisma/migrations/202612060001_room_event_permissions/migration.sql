-- ADR 0089 (Phase 4): permission catalogue rows for the Room Event Master admin API.
--
-- Mirrors 202609220001_supply_permissions. Only the two base (grantable) permissions per entity are rows here: 'room_event.approve' and
-- 'event_supplement.approve' are approval-only actions checked by ApprovalService against the TS permission catalogue
-- (packages/contracts/src/admin-departments.ts), never against this table, and so need no row of their own (same as contract.approve,
-- fx.activate and markup.activate before them).
--
-- Rollback: DELETE FROM "Permission" WHERE "key" IN ('supply.room_events.read', 'supply.room_events.manage', 'supply.event_supplements.read', 'supply.event_supplements.manage');
-- Safe only once no RolePermission row references them (ON DELETE behavior of RolePermission's permission_id FK governs whether that is automatic).

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_room_events_read', 'supply.room_events.read', 'Read Room Event Master records'),
  ('perm_supply_room_events_manage', 'supply.room_events.manage', 'Create, edit, submit, cancel and archive Room Event Master records'),
  ('perm_supply_event_supplements_read', 'supply.event_supplements.read', 'Read event and exhibition supplements'),
  ('perm_supply_event_supplements_manage', 'supply.event_supplements.manage', 'Create, edit, submit, activate and suspend event and exhibition supplements')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
