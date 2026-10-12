# ADR 0058: A primary image is a publication requirement

Status: Accepted and implemented on branch `claude/magical-ritchie-wnf0di`. Verified by unit tests and API e2e against local Postgres 16 with all migrations applied; the browser harness script was updated but not run.

## Context
Global bedbanks do not distribute a property without imagery, because a listing with no photo converts poorly and is the first thing a buyer reports. The blueprint left "at least one image" as an owner decision (ADR 0027 gave the module working images). The owner asked for the recommended option.

## Decision
- `HOTEL_PUBLICATION_REQUIREMENTS` gains `PRIMARY_IMAGE` ("Primary image with alt text", section `images`), so publication needs 13 requirements. Alt text is already mandatory on upload and the first image is the primary, so the requirement is the presence of a primary image row.
- It is evaluated by the same `assessCompleteness` everywhere: Hotel Setup, the publication request and apply, the legacy `/supply/hotels` edit guard, the directory profile summary and the Overview completeness.
- **No new loss path.** Deleting the last image of a published (COMPLETE) hotel is refused with 409 `HOTEL_PUBLICATION_REQUIREMENT_LOST`, like clearing any other requirement. Replacing the primary, reordering and deleting a non-last image are unaffected.
- **Grandfathering.** Hotels already published without an image stay published and show the requirement as unmet. `regressions` only lists requirements that were met and are no longer, so nothing locks them. Withdrawing and re-publishing them needs an image.
- Not changed: sellability and Agent search. This is catalogue-publication state only and enables no booking, payment or supplier path.
- No schema change and no migration.

## Not decided here
A minimum gallery size, image quality or rights checks, and a one-off backfill report listing published hotels with no image.

## Rollback
Remove the `PRIMARY_IMAGE` requirement and the last-image guard in `HotelImagesService.remove`. No data was migrated.

## Verification
Unit: `hotel-setup-rules.spec.ts` (new requirement). API e2e (local Postgres 16): `hotel-setup` (HS-06 now proves a hotel with a room but no image is not publishable), `strict-runtime-role-hotel-setup`, `agent-hotel-images` (AI-04 proves the last image of a published hotel cannot be deleted), `hotel-commercial` and the Dubai search suites pass. Not run: the browser harness (`verify-hotels.cjs` updated to upload an image before publishing and to expect 13 requirements), CI.
