# ADR 0027: Hotel images

## Status
Accepted for the Admin module. Adds the reviewed migration `202610150001_hotel_images` (one tenant-scoped table with forced RLS, integrity CHECKs, a unique and a partial unique index, and a conditional GRANT), applied only to disposable local databases. Closes the image gap in ADR 0021.

## Context
The Images tab offered no upload because the repository had no approved storage (ADR 0021). A separate proposal (docs PR, "ADR 0025") suggested Vercel Blob; that needs an account and token the build environment cannot create or verify. This ADR makes the capability real now and keeps the storage replaceable.

## Decisions
1. **Bytes live in PostgreSQL (`bytea`)** behind the table's tenant isolation, with the API as the only reader. This is chosen for the MVP because it is testable end to end and needs no new vendor. Rough sizing: 100 hotels x 15 images x ~400 KB is about 600 MB; the hard ceiling is 30 x 5 MB per hotel. If volume grows, move the bytes to object storage in a later ADR; the API, contracts and UI do not change, only `HotelImagesService`'s read and write of `data`.
2. **Limits (API and database):** JPEG, PNG or WebP only; 1 byte to 5 MB; 800x600 to 8000x8000 pixels; alt text 1 to 200 characters (required); 30 images per hotel (API, under a per-hotel advisory lock); one image per hotel and content hash (duplicates refused with 409).
3. **The bytes decide the type.** Type and pixel size are read from the file header (`hotel-image-probe`), never from the client's label or file name. A mismatch, an SVG, a GIF or anything else is 415. The declared type must equal the detected type. Size is capped while the body streams and only after authentication and authorization, so an unauthenticated caller cannot upload data.
4. **Primary image and order.** The first image is primary. Setting another primary clears the old one in the same transaction (a partial unique index guarantees at most one). Deleting the primary promotes the lowest-ordered remaining image. Order is an integer; ties break by upload time.
5. **Permissions:** list and content need `supply.hotels.read`; upload, edit and delete need `supply.hotels.manage`. A hotel or image of another tenant is a 404.
6. **Serving:** `GET /admin/hotels/:hotelId/images/:imageId/content` streams the bytes with the stored content type, `X-Content-Type-Options: nosniff`, a restrictive `Content-Security-Policy: sandbox`, an ETag from the content hash and `Cache-Control: private`. The list never reads the `data` column.
7. **Audit:** `hotel.image.uploaded`, `.updated` and `.deleted` record ids, sizes, dimensions, content type and changed field names; never the file, its name or its alt text.
8. **Display:** images are shown only in Admin. They are not yet shown to Agents or the Website, and an image is not a publication requirement. Both are separate decisions.

## Not built (stated, not hidden)
EXIF and other metadata are **not stripped** (no image library is installed); a malware scan; rights, licence and source records; supplier image import; room-level galleries; object storage; display to Agents or the Website; reordering as one atomic server operation (the UI swaps two positions with two requests).

## Consequences
- The Images tab is functional and honest about its limits. Applying the migration to a persistent database needs the ADR 0013 grant decision; without the grant the API reports images as unavailable.
- Rollback: revert the API and Admin, then a later forward migration may drop `HotelImage`. Images stored so far are lost on drop; export first.
