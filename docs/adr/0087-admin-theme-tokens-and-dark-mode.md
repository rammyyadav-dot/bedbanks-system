# ADR 0087: Admin theme tokens and dark mode

Status: **Built (Admin UI only; no API, schema or contract change).** Follows the "Not done" list of ADR 0085.

## Context
`globals.css` (~110 KB), `hotel-admin.css` and 123 TSX files hard-coded ~1,800 colour literals, so a dark theme could not be added without touching every one. A pure CSS `filter: invert()` was rejected: it shifts brand hues, mis-renders images and UA widgets, and is not a design token system.

## Decision
1. **Every colour is a token.** A mechanical codemod replaced each literal with `var(--c-<hex>)` (re-derived for dark) or `var(--k-<hex>)` (identical in both themes: dark chrome such as the sidebar, user menu and hotel header, plus shadows and scrims). `app/theme-tokens.css` holds the original light values (so **light mode is unchanged**) and the generated dark values.
2. **Deterministic dark derivation.** `lib/theme/color.ts` converts to OKLCH and applies one monotonic lightness curve (hue kept, pastel chroma reduced), so every foreground/background pair keeps its order and contrast. `pnpm theme:tokens` regenerates the dark block from the light block; a test fails if the committed file is stale.
3. **Switching without a flash or inline script.** The preference (`light` | `dark` | `system`, default **light**) is a plain `fbeds_theme` cookie. The root layout reads it on the server and renders `<html data-theme>`; `system` is handled in CSS by `prefers-color-scheme`. `ThemeToggle` (user menu and hotel account menu) applies the choice instantly and writes the cookie. It is a display preference only: no identity, tenant or permission data.
4. **Guards.** Tests fail on any raw colour literal outside the token file, on a referenced-but-undefined token, on a stale generated file, and on contrast regressions for representative pairs.

## Verified
Admin tests, type-check, lint, architecture checks and production build. Visual check: production build against a stub API in Chromium, light and dark, on /dashboard, /hotels, /bookings, /tenants, /finance/wallets, /access, /rates/plans and /exceptions, plus the user menu, with an automated text-contrast audit (text under 3:1 against its effective background). Result: no violations in dark except one pale table-header label that is equally pale in light.

Light-mode equivalence was measured, not assumed: the previous commit was built in a worktree and 14 pages (dashboard, hotels, bookings, tenants, finance, access, rate plans, exceptions, mappings, suppliers, connectors, contracts, audit, settings) were captured in light from both builds and diffed pixel by pixel. They are identical apart from the sidebar wordmark fix below (and one anti-aliased pixel on /hotels).

## Found and fixed on the way
- The sidebar wordmark was ink-on-ink (`#151515` on `#151515`) in light mode too; it is now white.
- The codemod mapped the CSS keyword `white` to a malformed token (`--c-#ffffff`), which silently dropped the background and border of every `.admin-btn` in light mode. The pixel diff caught it; the "every referenced token is defined" test now matches any `var(--c-…)`/`var(--k-…)` so a malformed name cannot slip past it.
- The codemod first mistook the word "filter" in TSX for a CSS filter, which would have left some text colours un-themed; the audit caught it.

## Not done / known limits
- **Not every page was inspected.** The stub API returns empty or not-found data, so pages were seen in their empty/error states. Data-heavy views (booking detail, rate grids, finance tables, dialogs, kanban, modals) share the same tokens but were not eyeballed with real data.
- Colour literals computed at runtime (none found) or inside `rgba()` shadows are not tokenised.
- Images are not dimmed in dark mode.
- Print output is unchanged only if the user prints from the light theme.
- The dark palette is derived, not designed: a designer may want to override individual tokens (edit the generator, not the output).
