# ADR 0050: Enterprise Hotel Overview

Status: implemented; local certification is engineering evidence, not permission to deploy.

The canonical Hotel, HotelProfile, RoomType, SupplierHotelMapping, Contract, RatePlan, BoardBasis and inventory models remain authoritative. Overview aggregates saved content and existing operational services; Hotel Setup owns validated edits and publication. No second master, evaluator, geographic registry or supplier-board mapping is introduced.

## Lifecycle

Append ARCHIVED to ContentStatus using forward-only migration 202611100001_hotel_archive. Archiving through the existing status endpoint requires hotel management permission, the reviewed concurrency token, idempotency key and a reason. It preserves the canonical ID, rooms, contracts, mappings, media and audit. Restore explicitly to DRAFT through that endpoint before requesting publication again. Archived hotels cannot request publication. All stay evaluations continue requiring COMPLETE; the single-night assessor also refuses ARCHIVED. COMPLETE means an approved profile, not guaranteed sellability. Activation remains the existing maker-checker hotel.activate approval: request, distinct reviewer, apply once with completeness/version rechecks. No new ACTIVE status is invented.

## Identity

Existing database uniqueness for tenant external references, external identifier schemes/values and supplier identities is retained. Canonical Hotel.id is never accepted as an editable/create input. New API creates and identity edits additionally refuse exact normalized name + country + city + street-address collisions in the tenant, using a transaction advisory lock to serialize competing claims. Whitespace and case differences do not bypass this check. Similar names or different addresses are not automatically the same property. Existing ambiguous duplicates are not merged or deleted. This is an API constraint; a privileged fixture/owner SQL connection is not subject to this business validation.

Setup save/status operations serialize their reviewed-token check through a per-hotel transaction lock. Legacy hotel edits additionally use updatedAt compare-and-swap, cannot introduce publication, cannot enter/leave ARCHIVED, and cannot remove an existing publication requirement while remaining COMPLETE. A legacy category change clears verification.

## Location and presentation

Location suggestions are tenant-scoped distinct country/city strings from canonical hotels, bounded to 250 countries and 200 cities, permission-guarded with no public geography fallback. Country selection uses ISO-2 format; new destinations remain explicitly editable because the current schema has no geographical master. Time zone must be deliberately entered in the Admin creation form; IANA validation uses the existing server rule. No geocoding or inference is added.

Amenity categories are presentation-only and retain the controlled catalogue, immutable codes and FREE/PAID/UNKNOWN semantics. Operational summaries use existing contracts, mappings and inventory APIs for the same assessed window. Permission denial, missing records and unavailable data remain distinct. Stock is never summed across plans sharing a pool.

## Safety

No new role grants, table policies or runtime authority are required. The enum migration is tested only on disposable PostgreSQL. Persistent migration execution, deployment, live suppliers, booking, payment and merge remain separately controlled and were not authorized by this work. This implementation is for fBeds; it introduces no integration or shared branding with UAEWB or fabBeds. Pre-existing unrelated Agent branding changes remain untouched.
