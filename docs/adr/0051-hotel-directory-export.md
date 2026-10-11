# ADR 0051: Hotel directory CSV export

Status: Accepted and implemented on branch `claude/awesome-shannon-ds37g8`. Not exercised against Postgres or a browser; see Verification.

## Decision
- New enforced permission `supply.hotels.export` (class S2: data egress). Separate from `supply.hotels.read`, because reading a page is not the same as taking a bulk copy. Added by a data-only migration (`202611110001_hotel_export_permission`) and **granted to no role**; a tenant administrator must assign it.
- `GET /admin/operations/hotels/export` reuses `OperationsHotelsService.list()`, so filters, tenant scoping (session-derived, RLS) and readiness come from the same code as the on-screen list. No second query path.
- Columns are directory fields only (canonical id, name, supplier code, location, stars, status, mapping, contract/rate/inventory state, readiness, issue count, updated). No contacts, owner, free text, rates, guest data or supplier payloads.
- Capped at 1000 rows. The response carries `X-Export-Rows` and `X-Export-Truncated`; the UI states plainly when a file is incomplete. A scan-cap hit also marks the file incomplete.
- An immutable `hotel.exported` audit event is written **before** the data is returned and stores filter keys, row count and truncation, never the data. If the audit write fails, nothing is exported.
- Cells beginning `= + - @ TAB CR` are prefixed with an apostrophe and special characters are quoted, so supplier-supplied names cannot run as spreadsheet formulas.

## Not decided here
Scheduled or asynchronous exports above 1000 rows, per-tenant retention of exports, and a row-level data-classification review of any additional column. Each needs its own decision.

## Rollback
`DELETE` the `RolePermission` and `Permission` rows for the key (see the migration header); remove the route.

## Verification
Unit: `hotel-export.spec.ts` (formula neutralization, column whitelist), controller wiring spec, permission-catalogue spec. **Not run:** Postgres e2e (no database in the authoring environment), cross-tenant negative test, browser download, strict-role grant check. These must pass before release.
