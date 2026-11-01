# ADR 0103: Agent portal and Supplier extranet adopt the fabBeds brand token kit

Status: **Built (Agent and Supplier UI only; no API, schema or contract change).** Extends ADR 0102 (Admin console).

## Context
ADR 0102 re-branded the Admin console to the CMO's fabBeds token kit v2.1. The Agent portal and Supplier extranet still used private palettes: raw hex literals in one large `globals.css` each (Agent: ~409 distinct colours; Supplier: ~161, plus a root palette of `--blue` CTA, `--teal`, `--ink`), a mix of red, blue, teal, orange and green, and system or never-loaded fonts (Montserrat, Courier New). Unlike the Admin they have no token layer and no dark theme.

## Decision
1. **One shared copy of the kit.** `app/brand-tokens.css` moved from the Admin into `packages/ui/src/brand-tokens.css` (`@bedbanks/ui`, already shared); the Admin, Agent and Supplier import it from there. The file is the CMO's kit unchanged except for the Google Fonts `@import` (self-hosted instead, below). The Admin and Supplier now declare `@bedbanks/ui` as a dependency.
2. **Self-hosted fonts.** Poppins (400-900) and IBM Plex Mono (500, 600) come from `@fontsource/*`, imported in each app's `layout.tsx`. No runtime request to Google.
3. **Raw hex becomes kit variables.** The same classification as ADR 0102 (hue, lightness and use: fill, text, border, outline, shadow) was applied once by a codemod, but writes `var(--fb-ink-*|red-*|mustard-*)` directly instead of renaming tokens, because these apps have no token file. Translucent colours become `color-mix(in srgb, var(--fb-ink-900) N%, transparent)`. The Supplier's root palette (`--red`, `--blue`, `--teal`, ...) was resolved at each use and removed; the Agent's shadcn root variables and its scoped `--sb-*` (search bar) and `--ck-*` (checkout) palettes are set to kit primitives by hand.
4. **Same semantics as the Admin.** Primary actions (Agent search and sign-in, Select Offer, Supplier `btn-primary`) are mustard with ink text, with mustard-600 / 700 for hover and pressed. Chrome and avatars are ink, logo marks and the stripe motif are brand red, links and accent text `red-700`, success is ink, warning mustard-tint, error red. Radii use the kit tokens (chip 6, control 10, card 14); fonts use `--fb-font-display` and `--fb-font-mono`.
5. **Screenshots.** `e2e/tests/07-agent-screenshots.spec.ts` is new (login, access request, home, a real Dubai search, the authoritative recheck, quotations, support, about, contact, news). `pnpm --filter @bedbanks/e2e e2e:screenshots` now captures Admin, Agent and Supplier.

## Verified
Type-check, lint and unit tests for the three apps (Admin 229, Agent 144, Supplier 16), `pnpm check:architecture`, production builds of all three, and live Playwright screenshots of Admin, Agent (11 pages) and Supplier (32 pages incl. mobile) after each change.

## Found and fixed on the way
- A hover rule written `:hover:not(:disabled)` was not recognised as the hover state of a mustard button and came out dark red; fixed by hand (the screenshot caught the cursor hovering after a click).
- CTA buttons kept an ink or red border from the old palette; they are mustard-bordered now, as in the Admin.
- The Supplier login backdrop's decorative stripe mapped to a large mustard slab; it is brand red (the kit's stripe), keeping mustard for actions only.

## Not done / known limits
- **Data-heavy views not inspected.** The preview data shows empty or "unavailable" states on most Supplier and Agent pages; booking, rate-grid, quotation-export and checkout flows with real data share the same variables but were not eyeballed.
- **Type scale unchanged**, as in ADR 0102 (only families, heading weight and button typography follow the kit).
- **No dark theme** exists in these apps; none was added. The Agent's `themeColor` for dark schemes is kit ink.
- **Pre-existing:** the Agent portal's header logo image is the supplied fabBeds artwork and is not recoloured.
- The public website app (`apps/website`) is not part of this change.
