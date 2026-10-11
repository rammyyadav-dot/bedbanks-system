# ADR 0052: "Request recertification" for hotels

Status: Option 1 adopted as an interim measure (no schema). Option 2 (tracked request) remains **not built and blocked on a product decision**.

Interim: the Hotels list shows "Re-check readiness" (permission `supply.rates.read`), which opens the hotel's Distribution & Readiness tab, where the canonical evaluator is run on demand. It records nothing and assigns nothing.

## Finding
The existing rate-certification module (`/admin/rate-certification/*`, `/rate-certification` page) is read-only: summary, plans, hotels, markup rules, remediation, a report, and a `simulate` call. It persists no certification run and no certification status. There is therefore nothing for a "request recertification" button to re-run or re-queue; building one would invent a new entity and workflow, not reuse one.

## Options
1. **No new feature.** Link each hotel to the existing rate-certification views and the sellability inspector. Zero schema. Recommended until someone needs tracked assignments.
2. **Tracked request.** New `HotelRecertificationRequest` (tenant-scoped, RLS, requester, hotel, reason, status OPEN/DONE/CANCELLED, idempotency key), a queue for Supply Operations, audited transitions. Needs a Prisma migration with rollback notes, a decision on who may complete a request and what "done" means (a re-run of the evaluator proves nothing was approved), and whether it is maker-checker.

## Decision needed
Choose option 1 or 2 and name the completing role. Until then no recertification control ships, and none is shown in the UI.
