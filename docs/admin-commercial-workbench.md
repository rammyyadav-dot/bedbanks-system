# Admin commercial workbench (Dubai MVP)

Operators prepare one hotel end to end from the Admin console using only authoritative APIs:

Supplier → Hotel → Room → Board Basis → Hotel mapping (approve) → Room mapping (approve) → Contract (ACTIVE) → Rate plan (ACTIVE) → Daily rates → Availability → **Sellability**.

| Screen | Route | Permission (UI hint; API enforces) |
|---|---|---|
| Suppliers (create/edit) | `/suppliers`, `/suppliers/new`, `/suppliers/[id]` | `supply.suppliers.manage` |
| Contracts + policies | `/contracts`, `/contracts/new`, `/contracts/[id]` | `supply.contracts.manage` |
| Rate plans | `/rates/plans`, `/rates/plans/new`, `/rates/plans/[id]` | `supply.rates.manage` |
| Rates & Inventory (7/30 days) | `/rates` (`/inventory` redirects) | `supply.rates.manage`, `supply.availability.manage` |
| Sellability inspector | `/sellability` | `supply.rates.read` |

## Behaviour worth knowing

- **Tenant header.** Browser API calls send `x-fbeds-tenant-id` (owner membership, else first). It is only a request: `TenantContextGuard` re-validates it against the authenticated user's membership and RLS on every call.
- **Capabilities.** `GET /supply/capabilities` returns the caller's own `supply.*` keys so the UI can hide controls. Failure to load it leaves controls visible; the API still decides.
- **Sellability.** `POST /supply/sellability` is evaluated per night. Optional `checkInDate` + `nights` add minimum stay, maximum stay and release-day checks. Room mapping must be `MAPPED` when the contract is bound to a hotel mapping. The inspector renders the returned reason codes verbatim.
- **Release days** are a rate-plan attribute (edited on the rate plan), not a per-day value.
- **Money.** Inputs are parsed to integer minor units with `BigInt` using the currency's fraction digits; nothing is rounded.
- **Not enabled** (explicit "not enabled" pages, no records): bookings, cancellations, finance, pricing simulator, search monitor, notifications, reports, tenants, users, audit.

## Known gaps

- P1: no tenant-scoped audit-read API for Admin (`/audit` shows an unavailable state).
- P1: the seeded `owner` role has no `supply.*` permissions; operators need a role granted them.
- P2: sellability evaluates one room and adults only; child policies and multi-room are not evaluated.
- P2: no supplier-contact metadata editor; no contract/rate-plan delete or clone.
