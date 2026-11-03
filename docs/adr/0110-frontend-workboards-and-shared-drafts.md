# ADR 0110: Admin workboard splitting, shared drafts, and contract versions

## Status
Accepted. No migration.

## Context
The admin and agent portals already share `@bedbanks/ui`, but that package only held a button. Hotel setup drafts, three-way merge, and session recovery lived in the admin app. The rates workbench, the hotel price grid, and ledger adjustments were static imports on their routes, so their editors shipped with the first script of those screens. The operations queue and hotel-mapping suggestions rendered every row. Daily rates and room allotment already send `expectedUpdatedAt` or a room concurrency token. A direct contract save did not, so two people editing the same draft could overwrite each other.

Portal-skinned tables, status pills, currency fields, and date fields are bound to each app's CSS. Moving them into `@bedbanks/ui` would either drag admin class names into the agent bundle or restyle both products.

## Decisions
1. **Heavy editors load on demand.** `RatesWorkbench`, `RateGrid`, and `LedgerAdjustments` are `next/dynamic` imports with the existing skeleton (`LoadingState`) as the fallback. `RateGrid` is fetched only when the hotel rates tab is opened in grid view.
2. **Long lists window their rows.** `@bedbanks/ui` exports `windowRange` and `useVirtualWindow`. The operations queue uses it above 25 rows (the default page stays fully rendered). Hotel-mapping suggestions use it above 8 matches. Until the scrollport is measured, every row is rendered.
3. **Draft helpers live in `@bedbanks/ui`.** `mergeDraft`, the session draft store, `useDraftState`, and `useDraftRecovery` are the shared implementation. Admin re-exports them. The agent quotation builder uses the same store and merge, and sign-out clears drafts in that origin. Private hotel contacts stay out of storage, as before.
4. **Contract saves carry the loaded `updatedAt`.** `classifyExpectedUpdatedAt` compares that instant to the locked row. A mismatch is `409 CONTRACT_CHANGED` and writes nothing. Omitting the field still works for an older client. `expectedUpdatedAt` is not a governance field, so an owner-only save on an ACTIVE contract stays a governance save. The contract form sends the timestamp it loaded.
5. **Dialog focus wrapping is shared.** Admin `Modal` uses `dialogTabTarget`. Data tables, status badges, currency selectors, and stay pickers stay in the app that styles them.

## Consequences
- A contract save from the admin form fails closed when another save landed first. The operator reloads; their typed values are not written.
- A quotation draft in this tab survives a reload and is discarded on sign-out. It is not an authority for price or tenant.
- Windowed rows use a fixed height. A queue page of 25 is unchanged. Find-in-page does not see rows that are scrolled out of a longer page.
- Rollback: revert the commit. No schema change.
