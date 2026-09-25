# Admin dashboard API

`GET /api/v1/admin/dashboard?range=7d|30d|90d` defaults to `7d`. All other query parameters and range values are rejected with 400 by the global validation pipe. The response uses the standard `{ success: true, data }` envelope and includes a server-generated `generatedAt` timestamp. Ranges start at midnight UTC, include the current day, and end at request time.

The existing opaque HttpOnly session cookie supplies the identity. `SessionAuthGuard` returns 401 without a valid session; `AdminRbacGuard` requires `dashboard.read` (or the existing tenant owner policy) and returns 403 otherwise. Both the guard and dashboard select the same server-loaded active membership: an owner membership if present, otherwise the first membership. No browser-supplied tenant ID is accepted. Dashboard reads execute inside `PrismaService.withTenant` with an explicit tenant predicate, alongside PostgreSQL tenant RLS. This endpoint does not grant platform-wide aggregation.

| Section | Source and current meaning |
| --- | --- |
| Summary.totalBookings | Authoritative count of Booking rows created within the range, all statuses |
| Summary.grossBookingValue | Sum of confirmed Booking.totalMinor in one currency only; null for no confirmed bookings or multiple currencies |
| Summary.netRevenue | Unavailable: no authoritative net revenue definition or source |
| Summary.activeSuppliers | Authoritative count of tenant Supplier rows with ACTIVE status |
| Summary.activeHotels | Unavailable: Hotel has content status, not an active commercial definition |
| Booking activity | Authoritative daily UTC counts, including confirmed counts; no 1,000-row cap |
| Revenue overview | Unavailable: no daily recognized revenue source |
| Recent bookings | Eight newest tenant bookings within the range; amounts are Booking.totalMinor |
| System health | API request served and database dashboard queries completed; no uptime/SLA claim; supplier health omitted |
| Alerts, destinations, supplier rankings | Empty because their operational sources/definitions are unavailable |

Money uses `{ amountMinor: string, currency: string }` to preserve bigint precision. The Admin renderer formats integer minor units using the currency's fraction digits. No FX conversion or cross-currency sum is performed. A booking's total is not represented as net revenue. Empty arrays are accompanied by the Admin page's unavailable states; an empty bookings/activity period is a measured zero.

The endpoint does not alter Prisma schema or migrations. The existing `Booking(tenantId,status)` index and tenant predicates apply; the UTC date filter and aggregate queries should be reviewed against production cardinality before high-volume rollout. No cache or supplier check is added.

Validation: `apps/api/test/admin-rbac.e2e-spec.ts` exercises session authorization, RBAC, all three ranges, invalid and browser-supplied tenant parameters, mixed-currency handling, server timestamp, response shape, and Tenant A/B isolation with database fixtures. The test needs a disposable PostgreSQL database with migrations applied. Smoke testing against any persistent environment is not part of this PR.
