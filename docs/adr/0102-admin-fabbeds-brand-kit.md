# ADR 0102: Admin console adopts the fabBeds brand token kit

Status: **Built (Admin UI only; no API, schema or contract change).** Builds on ADR 0087 (theme tokens and dark mode).
Note: the kit file now lives in `packages/ui/src/brand-tokens.css` and is shared with the Agent and Supplier apps (ADR 0103).

## Context
The CMO supplied the fabBeds brand token kit v2.1 (`fabbeds-tokens.css`): ink neutrals, brand red, CTA mustard, Poppins and IBM Plex Mono, and radii of 6 / 10 / 14 px. The Admin console still carried its original teal, navy and blue palette (about 640 hex-named colour tokens), a square 0px radius and fonts (Barlow Semi Condensed, Montserrat, Courier New) that were never loaded, so browsers rendered system fallbacks. The hotel-management header was even branded "UAE Hotels TMS", another product's name (see `docs/admin-hotel-mission-conformance.md`).

## Decision
1. **The kit is vendored unchanged** as `app/brand-tokens.css`, apart from its Google Fonts `@import`: the Admin CSP is `font-src 'self' data:`. Poppins (400-900) and IBM Plex Mono (500, 600) are self-hosted with `@fontsource/*` and imported in `app/layout.tsx`.
2. **Every Admin colour is now a kit primitive.** The ADR 0087 token system is kept (so dark mode and the "no raw colour literal" test still work) but its light block was re-mapped: about 640 old tokens collapsed to 48, each named after its new hex value. The mapping was done once by a codemod that classified every colour by hue, lightness and use (fill, text, border, outline, shadow):
   - cool/neutral greys, navy and teal chrome map to the ink ramp (sidebar and headers are `ink-900`);
   - reds map to `red-600` / `red-700` / `red-100`; ambers to `mustard-500` / `mustard-100`;
   - accent fills with white text on a button-like rule become the kit CTA: mustard fill, ink text, with hover `mustard-600` and pressed `mustard-700`; other teal/blue/green/purple fills become ink; accent text becomes `red-700` (brand/links) or ink (success), as the kit's status palette has no green, blue or purple.
3. **Semantics.** `--primary` (shadcn Button, and every `.admin-btn-primary`, search and done button) is mustard with ink text. Brand red is the logo mark, kickers, links, stop-sale and errors. Success is ink with an ink outline (kit `status-success`), warning is mustard, error is red. Radii use the kit tokens: chips 6, controls 10, cards/panels/modals/popovers 14. Fonts use `--fb-font-display` and `--fb-font-mono`.
4. **Guard.** `lib/theme-tokens.test.ts` now fails if any light token is not a kit ink, red or mustard primitive, so the console cannot drift back to a private palette. The earlier guards (no raw literals, every token defined, generated file in sync, contrast pairs) stay.
5. The hotel-management header reads "FBEDS / HOTEL MANAGEMENT" and the logo marks (login, sidebar, agent, hotel header) use brand red with white lettering.

## Verified
Admin tests (229), type-check, lint, `pnpm check:architecture`, production build, and live Playwright screenshots (`pnpm --filter @bedbanks/e2e e2e:screenshots`, 16 pages) after each change.

## Found and fixed on the way
- The mapping produced ink-on-ink logo marks (text and fill resolving to the same colour). A scan for rules where `color` equals `background` found four; all are fixed.
- A `color` field in a TSX status array (`SellabilityCard`) is used as a fill, so it was mapped as text; Partial now shows mustard and Blocked red.
- Several later override rules forced red fills on primary buttons; they are mustard now.
- Raw `rgba()` shadows and focus glows (teal, navy) are ink or the kit focus ring.

## Not done / known limits
- **Not every page was inspected with data.** The preview tenant shows empty, forbidden or not-enabled states on most pages; dialogs, rate grids, the bookings kanban and finance tables share the same tokens but were not eyeballed with real data.
- **Dark mode is derived, not designed.** The kit defines no dark theme; the ADR 0087 generator derives it from the new light block. It was not visually reviewed.
- **Type scale is unchanged.** The console is dense (9-12 px); the kit's 15-16 px body, uppercase display and uppercase titles were not applied to headings or body text. Only the font families, heading weight and `.admin-btn` button typography changed.
- **Status colour is the kit's.** Success, info and neutral all read as ink; status is carried by text, dot and outline, not hue. If operations teams need a distinct green, that is a brand decision.
- The agent, supplier and website apps are untouched.
