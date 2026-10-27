-- ADR 0101: finance period close. A calendar month (UTC) of the ledger is closed once: its per-currency control totals, integrity verdict and hash chain heads are recorded, and the
-- database then refuses any ledger entry dated inside it.
--
-- FinancePeriodClose  one row per tenant and month. CHECKs: the start is the first day of a month, the end is the first day of the next, the verdict is CLEAN or WARNINGS (a close with
--                     critical findings is refused by the service and cannot be stored), the note is 3 to 500 characters. A row is never updated or deleted (trigger, every role). It is never
--                     reopened: a late correction is posted as a new entry in the open period.
-- LedgerEntry         BEFORE INSERT trigger "LedgerEntry_period_lock": an entry whose immutable_at falls before the end of the tenant's latest closed period is refused. Entries take
--                     immutable_at from the database clock when created, so in normal operation this only stops a hand-written backdated insert. The check is one index lookup on
--                     (tenant_id, period_end) per insert. A DELETE or UPDATE is already refused by the append-only trigger (ADR 0069).
-- Permission          finance.period.close, granted to no role here.
--
-- No table is granted to any role: the service runs on the API connection like the credit note and adjustment services, and the table is classified finance-gated in the runtime-role
-- contract. Row-level security is ENABLED and FORCED. tenant_id leads both indexes.
--
-- Rollback (forward migration; reviewed before use; it discards the close records, so export them first; it removes the lock):
--   DROP TRIGGER "LedgerEntry_period_lock" ON "LedgerEntry"; DROP FUNCTION "fbeds_ledger_period_lock"(); DROP TABLE "FinancePeriodClose"; DROP FUNCTION "fbeds_finance_period_guard"();
--   DELETE FROM "Permission" WHERE key = 'finance.period.close';

-- CreateTable
CREATE TABLE "FinancePeriodClose" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "integrity_verdict" TEXT NOT NULL,
    "warning_count" INTEGER NOT NULL,
    "totals" JSONB NOT NULL,
    "chain_heads" JSONB NOT NULL,
    "note" TEXT,
    "closed_by_id" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancePeriodClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancePeriodClose_tenant_id_period_start_key" ON "FinancePeriodClose"("tenant_id", "period_start");

-- CreateIndex
CREATE INDEX "FinancePeriodClose_tenant_id_period_end_idx" ON "FinancePeriodClose"("tenant_id", "period_end");

-- AddForeignKey
ALTER TABLE "FinancePeriodClose" ADD CONSTRAINT "FinancePeriodClose_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity beyond Prisma
ALTER TABLE "FinancePeriodClose"
  ADD CONSTRAINT "FinancePeriodClose_month_start" CHECK (EXTRACT(DAY FROM "period_start") = 1),
  ADD CONSTRAINT "FinancePeriodClose_month_end" CHECK ("period_end" = ("period_start" + INTERVAL '1 month')::date),
  ADD CONSTRAINT "FinancePeriodClose_verdict" CHECK ("integrity_verdict" IN ('CLEAN', 'WARNINGS')),
  ADD CONSTRAINT "FinancePeriodClose_warning_count" CHECK ("warning_count" >= 0 AND ("integrity_verdict" = 'WARNINGS' OR "warning_count" = 0)),
  ADD CONSTRAINT "FinancePeriodClose_totals_shape" CHECK (jsonb_typeof("totals") = 'array' AND jsonb_typeof("chain_heads") = 'array'),
  ADD CONSTRAINT "FinancePeriodClose_note" CHECK ("note" IS NULL OR char_length("note") BETWEEN 3 AND 500);

-- Never updated, never deleted, for any role.
CREATE FUNCTION "fbeds_finance_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FinancePeriodClose is append-only; a closed period is never changed or reopened' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "FinancePeriodClose_guard" BEFORE UPDATE OR DELETE ON "FinancePeriodClose" FOR EACH ROW EXECUTE FUNCTION "fbeds_finance_period_guard"();

-- Row-level security
ALTER TABLE "FinancePeriodClose" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancePeriodClose" FORCE ROW LEVEL SECURITY;
CREATE POLICY "FinancePeriodClose_tenant_isolation" ON "FinancePeriodClose" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- The lock. SECURITY DEFINER so it reads the tenant's closes whatever role inserts the entry.
CREATE FUNCTION "fbeds_ledger_period_lock"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  locked_until date;
BEGIN
  SELECT max(p."period_end") INTO locked_until FROM "FinancePeriodClose" p WHERE p."tenant_id" = NEW."tenant_id";
  IF locked_until IS NOT NULL AND NEW."immutable_at" < locked_until::timestamp THEN
    RAISE EXCEPTION 'LedgerEntry is dated inside a closed finance period (closed until %); post the correction in the open period', locked_until USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "fbeds_ledger_period_lock"() FROM PUBLIC;
CREATE TRIGGER "LedgerEntry_period_lock" BEFORE INSERT ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_period_lock"();

-- Permission key enforced by the period close API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.period.close', 'Close a calendar month of the ledger: record its control totals and integrity verdict and lock it against new entries (never reopened)')
ON CONFLICT ("key") DO NOTHING;
