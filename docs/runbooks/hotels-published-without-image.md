# Runbook: published hotels without a primary image

Since ADR 0058 a primary image is a publication requirement. Hotels published before it stay published (grandfathered) and show the requirement as unmet. Use this read-only query to list them per tenant and plan the content work before telling operators about the rule.

Run as the migration/owner role in a read-only session (the runtime role is bound by row-level security). Replace `:tenant_id`.

```sql
SELECT h.id, h.name, h.city, h.country_code, h.updated_at
FROM "Hotel" h
WHERE h.tenant_id = :tenant_id
  AND h.content_status = 'COMPLETE'
  AND NOT EXISTS (SELECT 1 FROM "HotelImage" i WHERE i.hotel_id = h.id AND i.tenant_id = h.tenant_id AND i.is_primary)
ORDER BY h.name;
```

- Nothing here writes. Fix a hotel by uploading an image on its Images tab (alt text required).
- Do not insert image rows by hand: bytes, dimensions and the SHA-256 are validated on upload.
- Re-check after the work: the query should return no rows.
