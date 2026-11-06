# Room availability and allocation

Hotel administrators open a hotel, then **Room Availability** or **Allocation Mgmt**.

Room Availability paints Free Sale, Stop Sale, On Request and Limited for stay nights. Both stay dates in a bulk edit are inclusive. A booking search still treats check-in as inclusive and check-out as exclusive. Dates are hotel-local. The save time is UTC.

Allocation shows, for each room type and shared pool, the contracted figure, approved adjustment, confirmed bookings, active holds, blocked quantity, remaining inventory, release cutoff and post-release policy. Remaining inventory is calculated by the API.

A green Free Sale cell does not confirm a booking. Saving a change does not mean a channel acknowledged it. The delivery control says the adapter is simulated and that there is no live supplier connection.

## Run

1. Apply `apps/api/prisma/migrations/202612200001_room_sales_controls` with the repository's forward migration command on a database you can reset.
2. Start the API and Admin as the rest of the monorepo does.
3. Open a hotel that already has room types, a contract and pool nights. The calendar loads from `GET /api/v1/admin/hotels/:hotelId/inventory/sales/calendar`.
4. Paint, preview, then save with a reason. Reload the calendar. The distribution row stays pending until **Retry simulated delivery**.
5. Use **Check a stay** for eligibility. It does not reserve inventory.

`tools/admin-ops-verify/seed-room-sales.ts` inserts Classic Room, Deluxe Room, Executive Room and Family Suite on a disposable local database (`fbeds_ci` or `p0N_*`). It refuses any other `DATABASE_URL`.

## API

All routes are under `/admin/hotels/:hotelId/inventory` and use the session tenant.

| Method | Path | Permission |
|---|---|---|
| GET | `/sales/calendar` | `supply.availability.read` |
| POST | `/sales/preview` | `supply.availability.manage` |
| POST | `/sales/commit` | `supply.availability.manage` |
| GET | `/sales/history` | `supply.availability.read` |
| POST | `/sales/eligibility` | `supply.availability.read` |
| GET | `/allocation` | `supply.availability.read` |
| POST | `/allocation/apply` | `supply.availability.manage` |
| POST | `/allocation/release` | `supply.availability.manage` |
| POST | `/sales/requests` | `supply.availability.manage` |
| POST | `/sales/requests/:requestId/decide` | `supply.availability.manage` |
| POST | `/sales/requests/expire` | `supply.availability.manage` |
| GET | `/sales/distribution` | `supply.availability.read` |
| POST | `/sales/distribution/:jobId/deliver` | `supply.availability.manage` |

Request and response fields are `packages/contracts/src/room-sales.ts`. A commit needs the preview fingerprint and an idempotency key. The same key with a different body is rejected. A stale fingerprint saves nothing.

## Limits

- No saved rule does not turn an existing allotment unsellable. The calendar shows **Not configured**. Search keeps the rate plan's inventory mode until a rule is saved.
- The simulated adapter never talks to a supplier.
- An On Request approval does not create a reservation and does not place a temporary hold.
- The booking hold rechecks all-market rules and the portal channel. A market-only stop is enforced when search or eligibility is given that market.
