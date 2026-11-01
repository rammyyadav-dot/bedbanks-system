# ADR 0025: Hotel images (PROPOSAL, superseded by ADR 0027)

## Status
**Superseded by [ADR 0027](0027-hotel-images.md)**, which built hotel images with the image bytes in PostgreSQL behind a storage port instead of Vercel Blob (no account or token needed, fully testable). This file is kept as the record of the original proposal; moving to object storage later would be a new ADR. Original status follows.

**Proposed.** Written for the owner to accept, change or reject. No code, migration or storage account exists for it, and the Images tab keeps stating that upload is unavailable (ADR 0021) until this is accepted and built. The numbers ADR 0022 to 0024 are used by the publication and credit-limit work; this file does not depend on them.

## Context
Hotel Operations (ADR 0021) has an Images tab that honestly offers no upload because there is no approved storage. Images are content a hotel must show before it is attractive in the catalogue, but they are not a publication requirement today.

## Proposed decisions (defaults to confirm)
1. **Storage:** Vercel Blob, one private store per environment, objects keyed `tenant/<tenantId>/hotel/<hotelId>/<imageId>`. Needs a Blob store and a server-only read-write token created by the owner; it is never exposed to a browser app.
2. **Upload path:** Admin sends the file to the API (not directly to Blob). The API checks permission (`supply.hotels.manage`), size (at most 5 MB), type by content sniffing (JPEG, PNG, WebP only), pixel size (at least 800x600, at most 8000x8000) and rejects everything else, then writes to Blob and records the image. Metadata is stripped.
3. **Table `HotelImage`** (tenant-scoped, forced RLS): id, tenant, hotel, blob key, content type, bytes, width, height, sha256, alt text (required, at most 200 characters), sort order, `isPrimary`, uploaded by, created at. Unique (hotel, sha256) prevents duplicates. At most 30 images per hotel.
4. **Display:** a tenant-scoped API route streams or redirects with a short-lived signed URL; Agent and Website show images only for hotels with `contentStatus: COMPLETE`. No hotlinking of supplier images and no images copied from suppliers without a stated licence.
5. **Audit:** upload, reorder, change alt text, set primary and delete write audit events with image ids and sizes only, never the file or its name.
6. **Not included:** image editing, AI alt text, supplier image sync, room-level galleries.

## Decisions needed from the owner
Confirm Vercel Blob (or name S3/R2), the 5 MB and 30-image limits, and whether at least one image should become a publication requirement.

## Consequences if accepted
One migration (with the conditional grant needing the ADR 0013 decision), a storage adapter behind a port, an upload endpoint, and the Images tab becomes functional. A malware scan is not proposed; if the owner requires one, a scanning service must be named.
