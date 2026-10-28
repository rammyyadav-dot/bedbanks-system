-- ADR 0103: the permission that gates the CSV export of the general-ledger journal. Granted to no role here; a formal role assignment is the only way to hold it.
-- No table, role grant or index changes. Rollback: DELETE FROM "Permission" WHERE key = 'finance.journal.export';
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.journal.export', 'Download the general-ledger journal of a closed month as a CSV file (each download is audited with the hash of the file)')
ON CONFLICT ("key") DO NOTHING;
