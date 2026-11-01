# ADR 0101: Hotel image decoding and Admin draft protection

## Status
Accepted. Amends ADR 0027 decision 3 and its "no image library" note. No migration.

## Context
An audit of the hotel Admin app found five defects that share one cause: a check that looked at the shape of something instead of the thing itself.
1. Image upload read only the file header, so a 24-byte PNG (signature plus size, no pixels) was stored as a 1600x1200 image.
2. The two Policies editors shared one concurrency token and were re-keyed on every save, so saving one silently discarded the other's unsaved edits.
3. Fields stayed editable while a save was in flight; the reload that followed replaced them.
4. The unsaved-changes hook covered anchor clicks and unload but not Back/Forward or programmatic navigation, and each dirty editor installed its own listener (duplicate prompts).
5. The lifecycle control started on DRAFT for a DRAFT hotel while excluding DRAFT from its options, so the visible choice and the submitted value could differ.

## Decisions
1. **Images are decoded, not just probed.** `inspectImage` keeps the cheap header probe (type and claimed size, checked against the existing limits first) and then fully decodes the file with `sharp` (libvips) using `failOn: 'error'`, `limitInputPixels` equal to the largest accepted frame (8000x8000) and sequential reads. Decoding streams through a statistics pass, so decoded pixels are never buffered. The decoded format and size must match the header and the declared content type. Truncated, header-only or structurally corrupt files are 415 `HOTEL_IMAGE_UNSUPPORTED_TYPE` before anything is stored. Limits, tenant isolation, permissions and the publication check are unchanged. `sharp` was already pinned by the root override (`^0.35.5`, a Next.js image dependency); the API now declares it directly, and the lockfile change is that one importer entry. It is a native module: the runtime image is Alpine (musl) and the lockfile carries the musl binaries. EXIF is still not stripped (we validate, we do not re-encode).
2. **One stored version, independent drafts.** Setup, Policies and Local charges keep the stored version in state and replace it with the setup the server returns. A save never remounts an editor. `useDraftState` merges a draft onto a changed stored version field by field (`mergeDraft`, three-way): untouched fields take the new value, edited fields keep the draft, fields edited on both sides keep the operator's value and are announced. Only one save runs at a time per panel because both editors use the same token.
3. **Edits during a save are preserved, not blocked.** What is submitted is fixed at click time; on success only the submitted fields adopt the server's normalised values and anything typed afterwards stays and stays dirty. A failure keeps the draft and the idempotency key (a retry of the same content is a replay); any edit issues a new key. A stale token is explained and the operator chooses "load the latest and keep my edits" (merge) or "discard my edits".
4. **Navigation guard.** Next.js 16 has no route-blocking API, so `unsaved-guard.ts` owns one set of listeners for the whole page: `beforeunload`; a capturing click listener (links, tab changes, hotel switches, keyboard activation); the Navigation API `navigate` event for Back/Forward (cancelable in Chromium), falling back to holding the `popstate` event back from the router and undoing the traversal with `history.go()` if the operator declines; and `confirmDiscard()` for programmatic navigation (tenant switch, sign-out). One prompt per attempt. Browsers without the Navigation API get no Back/Forward prompt.
5. **Recoverable drafts.** Where blocking is unreliable (no Navigation API, a crash, a confirmed leave) the draft is kept in this tab's `sessionStorage` (scoped by editor and hotel, never sent anywhere), restored with a visible notice and merged onto the current stored version. Private hotel contacts are never written to storage. Sign-out clears all drafts. Storage failures degrade to "no draft".
6. **Lifecycle control.** `allowedStatusTargets(current)` is the single list for the options and the submitted value. Nothing is preselected; Apply stays disabled until a target and a reason are given.
7. **API client.** HTTP success is not mutation success. `apiRequestWithMeta` accepts only `{ success: true, data }`; `success:false`, empty, truncated, non-JSON or non-envelope bodies raise `ApiResponseError` (`API_MALFORMED_RESPONSE` for the latter) with the request id and any API code and details preserved.

## Consequences
- A corrupt JPEG or WebP whose damage is confined to entropy-coded data (no checksum in those formats) can still decode; truncation, missing data and structural damage are caught. PNG has CRCs and is checked completely.
- Decoding costs CPU on upload (bounded by the 5 MB and 64 MP limits).
- The guard is best-effort by nature of the platform. The browser's own `beforeunload` prompt is the only protection for a hard navigation, and Safari/Firefox builds without the Navigation API rely on draft recovery for Back/Forward.
- Rollback: revert the commit; remove `sharp` from `apps/api/package.json` and restore the lockfile.
