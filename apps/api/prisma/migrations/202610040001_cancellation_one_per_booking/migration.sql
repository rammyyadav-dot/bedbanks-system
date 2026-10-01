-- A booking can be cancelled at most once. Enforced in the database so concurrent or replayed
-- cancellations cannot create two refund records. No code path created Cancellation rows before this
-- release (cancellation was a fail-closed stub), so the index cannot conflict with existing data.
-- Rollback: DROP INDEX "Cancellation_booking_id_key";
CREATE UNIQUE INDEX "Cancellation_booking_id_key" ON "Cancellation"("booking_id");
