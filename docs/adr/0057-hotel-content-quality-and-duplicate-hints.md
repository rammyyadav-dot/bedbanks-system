# ADR 0057: Hotel content quality grade, duplicate hints and coordinate sanity

Status: Accepted and implemented on branch `claude/magical-ritchie-wnf0di`. Unit-tested and type-checked; not exercised against Postgres or in a browser.

## Context
Global bedbanks grade static content and de-duplicate properties before distribution, because poor content and double-listed hotels cost conversion and cause double mapping. The Admin hotel module gated publication on 12 requirements and refused only exact name+city+address duplicates. It could not tell an operator how good a profile was, or that "Palm View Hotel" and "The Palm View" were the same property.

## Decision
- **Content quality grade** (`@bedbanks/contracts` `hotel-quality.ts`, `assessContentQuality`): 11 weighted signals summing to 100 (descriptions, primary image, gallery of 5, 5 amenities, languages, 3 policies, star source, external identifier, postal code and area, chain or brand). Tiers BRONZE under 50, SILVER 50-79, GOLD 80+. Returned as `HotelSetupView.quality`.
- **Advisory only.** It does not change publishability, sellability, rates or inventory. `HOTEL_PUBLICATION_REQUIREMENTS` stays the single publication gate. Making an image mandatory for publication remains an owner decision (blueprint section 11).
- **Near-duplicate hints** (`findPossibleDuplicates`): same tenant and country only, from a similar name (token Jaccard 0.6 after removing generic words) within 150 m, or a similar name with the same postal code and city. A shared external identifier is deliberately not a signal: identifiers are unique per tenant, scheme and value, so it cannot occur inside one tenant. Scans at most 500 peers by id; a hint for a human, never an automatic block or merge. Returned as `HotelSetupView.possibleDuplicates`.
- **Coordinate sanity:** latitude and longitude 0,0 no longer satisfy the COORDINATES publication requirement. A real position on only one axis at 0 is accepted.
- No schema change, no migration, no new permission: it reads existing tables through the existing `supply.hotels.read` setup endpoint. Coordinates are display values; the no-float rule concerns money.

## Not decided here
Cross-tenant or supplier-catalogue de-duplication (that belongs with supplier mapping), automatic merge, a mandatory-image publication rule, and tuning thresholds against real Dubai data.

## Rollback
Revert the commit. No data was written or migrated.

## Verification
Unit: `hotel-content-quality.spec.ts`, `hotel-duplicates.spec.ts`, `hotel-setup-rules.spec.ts` (placeholder coordinates). Type-check, lint and `pnpm check:architecture` pass. Not run: API e2e against Postgres, browser harness.
