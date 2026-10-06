-- ADR 0039, Phase 5: a fourth immutable booking document, the cancellation note (the spec's document for a cancelled booking, next to the credit note).
-- Alone in its own migration because a new enum value cannot be used in the transaction that adds it. Additive; no row, policy or grant changes.
-- Rollback: PostgreSQL cannot drop an enum value. Nothing reads CANCELLATION_NOTE unless a document of that type exists; an owner can leave it in place unused.
ALTER TYPE "BookingDocumentType" ADD VALUE IF NOT EXISTS 'CANCELLATION_NOTE';
