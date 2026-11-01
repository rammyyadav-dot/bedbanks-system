-- ADR 0094: tamper-evident ledger. Every LedgerEntry gets one link in a per-wallet SHA-256 hash chain, written by the database in the same transaction as the entry.
--
-- Why: "LedgerEntry" is already append-only by trigger (ADR 0069), but a trigger can be disabled by a database owner. A chain makes an edit, a deletion or an insertion
-- behind the application's back DETECTABLE: every link commits to the previous link's hash and to the entry's content.
--
-- LedgerChainLink    id, tenant_id, wallet_id, ledger_entry_id (unique), seq (1.. per wallet), prev_hash (64 zeros for the first), entry_hash, created_at. Append-only (trigger).
--                    Written ONLY by the SECURITY DEFINER trigger below: no role is granted INSERT, UPDATE or DELETE, so an application bug or a narrow role cannot forge a link.
--   entry_hash = lower hex SHA-256 of the UTF-8 text  prev_hash|id|tenant_id|wallet_id|type|amount_minor|currency|reference ('' when null)|idempotency_key|immutable_at
--   with immutable_at as YYYY-MM-DDTHH24:MI:SS.MSZ (UTC, millisecond precision). The formula lives in "fbeds_ledger_chain_hash" and nowhere else.
-- Concurrency       The trigger takes FOR NO KEY UPDATE on the entry's "Wallet" row before reading the last link: the same lock the booking and cancellation paths already hold, so the lock order
--                   cannot invert, two writers of one wallet are serialised for the instant of the append, and different wallets never wait on each other.
-- Backfill          Existing entries are chained in (immutable_at, id) order inside this migration. The chain therefore attests entries only from the time of this migration: a change made BEFORE it is not detectable.
--                   Run the ledger integrity report first (it must be CLEAN) and keep its output with the release record. The backfill takes one pass over "LedgerEntry".
-- Verification      "fbeds_ledger_chain_breaks"() (current tenant only) returns one row per fault: SEQUENCE_GAP, PREV_HASH_MISMATCH, ENTRY_MISSING, ENTRY_HASH_MISMATCH, ENTRY_UNCHAINED.
--                   "fbeds_ledger_chain_heads"() returns each wallet's last seq and hash, to be copied to storage outside the database (otherwise the newest links of a wallet could be removed together).
--                   EXECUTE is not granted to any role here; the ledger integrity login and the owner role run them. Both are tenant-filtered because SECURITY DEFINER bypasses nothing by itself.
-- Tenant-index review   tenant_id leads the one non-unique index; the unique keys are (wallet_id, seq) and (ledger_entry_id), both reachable only through a composite tenant foreign key.
--
-- Rollback (forward migration; reviewed before use; it discards the chain, not the ledger):
--   DROP TRIGGER "LedgerEntry_chain" ON "LedgerEntry"; DROP FUNCTION "fbeds_ledger_chain_append"(); DROP FUNCTION "fbeds_ledger_chain_breaks"(); DROP FUNCTION "fbeds_ledger_chain_heads"();
--   DROP TABLE "LedgerChainLink"; DROP FUNCTION "fbeds_ledger_chain_immutable"(); DROP FUNCTION "fbeds_ledger_chain_hash"(text, text, text, text, text, bigint, text, text, text, timestamp);

-- CreateTable
CREATE TABLE "LedgerChainLink" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "ledger_entry_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "prev_hash" CHAR(64) NOT NULL,
    "entry_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerChainLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerChainLink_tenant_id_wallet_id_idx" ON "LedgerChainLink"("tenant_id", "wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerChainLink_ledger_entry_id_key" ON "LedgerChainLink"("ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerChainLink_wallet_id_seq_key" ON "LedgerChainLink"("wallet_id", "seq");

-- AddForeignKey
ALTER TABLE "LedgerChainLink" ADD CONSTRAINT "LedgerChainLink_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerChainLink" ADD CONSTRAINT "LedgerChainLink_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerChainLink" ADD CONSTRAINT "LedgerChainLink_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerChainLink"
  ADD CONSTRAINT "LedgerChainLink_seq_positive" CHECK ("seq" >= 1),
  ADD CONSTRAINT "LedgerChainLink_hashes" CHECK ("prev_hash" ~ '^[0-9a-f]{64}$' AND "entry_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "LedgerChainLink_first_is_genesis" CHECK ("seq" > 1 OR "prev_hash" = repeat('0', 64));

-- The one definition of the hash (see the header for the canonical text).
CREATE FUNCTION "fbeds_ledger_chain_hash"(p_prev text, p_id text, p_tenant text, p_wallet text, p_type text, p_amount bigint, p_currency text, p_reference text, p_key text, p_at timestamp)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', p_prev, p_id, p_tenant, p_wallet, p_type, p_amount::text, p_currency, coalesce(p_reference, ''), p_key, to_char(p_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), 'UTF8')), 'hex')
$$;

-- A link is never changed or deleted. A DELETE is allowed only under the same owner-governed erasure switch as "LedgerEntry" (the application never sets it).
CREATE FUNCTION "fbeds_ledger_chain_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fbeds.ledger_erasure', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'LedgerChainLink is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER "LedgerChainLink_immutable" BEFORE UPDATE OR DELETE ON "LedgerChainLink" FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_chain_immutable"();

-- Backfill, one tenant at a time (row-level security is forced for the owner, so the tenant context is set per tenant; it is transaction-local).
DO $$
DECLARE
  t record;
  w record;
  e record;
  prev text;
  n integer;
  h text;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.current_tenant_id', t."id", true);
    FOR w IN SELECT "id" FROM "Wallet" WHERE "tenant_id" = t."id" LOOP
      prev := repeat('0', 64);
      n := 0;
      FOR e IN SELECT * FROM "LedgerEntry" WHERE "wallet_id" = w."id" AND "tenant_id" = t."id" ORDER BY "immutable_at", "id" LOOP
        n := n + 1;
        h := "fbeds_ledger_chain_hash"(prev, e."id", e."tenant_id", e."wallet_id", e."type"::text, e."amount_minor", e."currency", e."reference", e."idempotency_key", e."immutable_at");
        INSERT INTO "LedgerChainLink" ("id", "tenant_id", "wallet_id", "ledger_entry_id", "seq", "prev_hash", "entry_hash") VALUES (gen_random_uuid()::text, e."tenant_id", e."wallet_id", e."id", n, prev, h);
        prev := h;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;

-- Row-level security (after the backfill).
ALTER TABLE "LedgerChainLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerChainLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY "LedgerChainLink_tenant_isolation" ON "LedgerChainLink" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- The writer. SECURITY DEFINER so no application role needs (or has) INSERT on the chain.
CREATE FUNCTION "fbeds_ledger_chain_append"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  last_seq integer;
  last_hash text;
BEGIN
  PERFORM 1 FROM "Wallet" WHERE "id" = NEW."wallet_id" FOR NO KEY UPDATE;
  SELECT l."seq", l."entry_hash" INTO last_seq, last_hash FROM "LedgerChainLink" l WHERE l."wallet_id" = NEW."wallet_id" ORDER BY l."seq" DESC LIMIT 1;
  IF last_seq IS NULL THEN last_seq := 0; last_hash := repeat('0', 64); END IF;
  INSERT INTO "LedgerChainLink" ("id", "tenant_id", "wallet_id", "ledger_entry_id", "seq", "prev_hash", "entry_hash")
  VALUES (gen_random_uuid()::text, NEW."tenant_id", NEW."wallet_id", NEW."id", last_seq + 1, last_hash,
          "fbeds_ledger_chain_hash"(last_hash, NEW."id", NEW."tenant_id", NEW."wallet_id", NEW."type"::text, NEW."amount_minor", NEW."currency", NEW."reference", NEW."idempotency_key", NEW."immutable_at"));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION "fbeds_ledger_chain_append"() FROM PUBLIC;
CREATE TRIGGER "LedgerEntry_chain" AFTER INSERT ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_chain_append"();

-- The verifier: one row per fault, current tenant only.
CREATE FUNCTION "fbeds_ledger_chain_breaks"() RETURNS TABLE ("wallet_id" text, "entry_id" text, "seq" integer, "reason" text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  WITH links AS (
    SELECT l."wallet_id", l."ledger_entry_id", l."seq", l."prev_hash", l."entry_hash",
           row_number() OVER (PARTITION BY l."wallet_id" ORDER BY l."seq") AS rn,
           lag(l."entry_hash") OVER (PARTITION BY l."wallet_id" ORDER BY l."seq") AS actual_prev
      FROM "LedgerChainLink" l WHERE l."tenant_id" = "fbeds_current_tenant_id"()
  ), checked AS (
    SELECT k."wallet_id", k."ledger_entry_id", k."seq", k."rn", k."prev_hash", k."actual_prev", k."entry_hash", e."id" AS found_id,
           "fbeds_ledger_chain_hash"(k."prev_hash", e."id", e."tenant_id", e."wallet_id", e."type"::text, e."amount_minor", e."currency", e."reference", e."idempotency_key", e."immutable_at") AS expected_hash,
           e."wallet_id" AS entry_wallet
      FROM links k LEFT JOIN "LedgerEntry" e ON e."id" = k."ledger_entry_id" AND e."tenant_id" = "fbeds_current_tenant_id"()
  )
  SELECT c."wallet_id", c."ledger_entry_id", c."seq", 'SEQUENCE_GAP' FROM checked c WHERE c."seq" <> c."rn"
  UNION ALL SELECT c."wallet_id", c."ledger_entry_id", c."seq", 'PREV_HASH_MISMATCH' FROM checked c WHERE c."prev_hash" <> coalesce(c."actual_prev", repeat('0', 64))
  UNION ALL SELECT c."wallet_id", c."ledger_entry_id", c."seq", 'ENTRY_MISSING' FROM checked c WHERE c."found_id" IS NULL
  UNION ALL SELECT c."wallet_id", c."ledger_entry_id", c."seq", 'ENTRY_HASH_MISMATCH' FROM checked c WHERE c."found_id" IS NOT NULL AND (c."entry_hash" <> c."expected_hash" OR c."entry_wallet" <> c."wallet_id")
  UNION ALL SELECT e."wallet_id", e."id", NULL::integer, 'ENTRY_UNCHAINED' FROM "LedgerEntry" e
             WHERE e."tenant_id" = "fbeds_current_tenant_id"() AND NOT EXISTS (SELECT 1 FROM "LedgerChainLink" l WHERE l."ledger_entry_id" = e."id")
$$;
REVOKE ALL ON FUNCTION "fbeds_ledger_chain_breaks"() FROM PUBLIC;

-- Each wallet's newest link, to be copied outside the database as an anchor.
CREATE FUNCTION "fbeds_ledger_chain_heads"() RETURNS TABLE ("wallet_id" text, "seq" integer, "entry_hash" text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT DISTINCT ON (l."wallet_id") l."wallet_id", l."seq", l."entry_hash"::text FROM "LedgerChainLink" l WHERE l."tenant_id" = "fbeds_current_tenant_id"() ORDER BY l."wallet_id", l."seq" DESC
$$;
REVOKE ALL ON FUNCTION "fbeds_ledger_chain_heads"() FROM PUBLIC;
