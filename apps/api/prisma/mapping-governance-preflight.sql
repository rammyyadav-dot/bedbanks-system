-- Run with approved read-only credentials in every environment containing
-- SupplierHotelMapping data. Every count must equal zero before deployment.
BEGIN READ ONLY;
-- FORCE RLS can otherwise make a zero-row report falsely reassuring.
-- Use a reviewed read-only audit role with complete mapping visibility;
-- never treat a tenant-scoped session as a global preflight.
DO $$ BEGIN
  IF row_security_active('"SupplierHotelMapping"'::regclass)
    OR row_security_active('"Supplier"'::regclass)
    OR row_security_active('"Hotel"'::regclass) THEN
    RAISE EXCEPTION 'Global mapping preflight requires a read-only role with complete RLS visibility';
  END IF;
END $$;
SELECT 'supplier_tenant_mismatch' AS check_name, count(*) AS incompatible_rows FROM "SupplierHotelMapping" m JOIN "Supplier" s ON s.id = m.supplier_id WHERE m.tenant_id IS DISTINCT FROM s.tenant_id
UNION ALL SELECT 'hotel_tenant_mismatch', count(*) FROM "SupplierHotelMapping" m JOIN "Hotel" h ON h.id = m.hotel_id WHERE m.tenant_id IS DISTINCT FROM h.tenant_id
UNION ALL SELECT 'duplicate_external_identity', count(*) FROM (SELECT 1 FROM "SupplierHotelMapping" GROUP BY supplier_id, supplier_hotel_id HAVING count(*) > 1) t
UNION ALL SELECT 'duplicate_canonical_identity', count(*) FROM (SELECT 1 FROM "SupplierHotelMapping" GROUP BY supplier_id, hotel_id HAVING count(*) > 1) t
UNION ALL SELECT 'null_external_id', count(*) FROM "SupplierHotelMapping" WHERE supplier_hotel_id IS NULL
UNION ALL SELECT 'blank_external_id', count(*) FROM "SupplierHotelMapping" WHERE supplier_hotel_id = ''
UNION ALL SELECT 'whitespace_external_id', count(*) FROM "SupplierHotelMapping" WHERE supplier_hotel_id <> '' AND btrim(supplier_hotel_id) = ''
UNION ALL SELECT 'unexpected_status', count(*) FROM "SupplierHotelMapping" WHERE status::text NOT IN ('PENDING', 'MAPPED', 'REJECTED')
UNION ALL SELECT 'orphan_supplier', count(*) FROM "SupplierHotelMapping" m LEFT JOIN "Supplier" s ON s.id = m.supplier_id WHERE s.id IS NULL
UNION ALL SELECT 'orphan_hotel', count(*) FROM "SupplierHotelMapping" m LEFT JOIN "Hotel" h ON h.id = m.hotel_id WHERE h.id IS NULL
UNION ALL SELECT 'composite_supplier_key_conflict', count(*) FROM (SELECT 1 FROM "Supplier" GROUP BY tenant_id, id HAVING count(*) > 1) t
UNION ALL SELECT 'composite_hotel_key_conflict', count(*) FROM (SELECT 1 FROM "Hotel" GROUP BY tenant_id, id HAVING count(*) > 1) t
UNION ALL SELECT 'composite_room_key_conflict', count(*) FROM (SELECT 1 FROM "RoomType" GROUP BY hotel_id, id HAVING count(*) > 1) t
UNION ALL SELECT 'composite_mapping_key_conflict', count(*) FROM (SELECT 1 FROM "SupplierHotelMapping" GROUP BY tenant_id, id, hotel_id HAVING count(*) > 1) t;
-- Inspect only the IDs of offending mapping records. Do not export supplier data.
SELECT m.id FROM "SupplierHotelMapping" m
LEFT JOIN "Supplier" s ON s.id = m.supplier_id LEFT JOIN "Hotel" h ON h.id = m.hotel_id
WHERE s.id IS NULL OR h.id IS NULL OR m.tenant_id IS DISTINCT FROM s.tenant_id
OR m.tenant_id IS DISTINCT FROM h.tenant_id OR btrim(m.supplier_hotel_id) = ''
LIMIT 20;
COMMIT;
