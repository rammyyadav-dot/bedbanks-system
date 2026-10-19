-- ADR 0072: a new money-fact type for an approved amendment. Alone in its own migration because PostgreSQL does not let a new enum value be used (for
-- example in a CHECK) in the transaction that adds it; the next migration uses it.
--
-- Rollback notes: PostgreSQL cannot drop an enum value. Ensure no BookingFinanceEvent row has type 'AMENDED' (the table is append-only, so in practice the value stays),
-- then leave it unused. Nothing else in the schema changes here.
ALTER TYPE "BookingFinanceEventType" ADD VALUE IF NOT EXISTS 'AMENDED';
