# ADR 0104: Public website adopts the fabBeds brand token kit

Status: **Built (website UI only; no API, schema or contract change).** Completes ADR 0102 (Admin) and ADR 0103 (Agent, Supplier).

## Context
`apps/website` styled itself with Tailwind theme colours (`--color-brand: #e50914`, a green `--color-trust`, gold `#ffd700`) plus ~100 raw hex literals in `app/globals.css`, a system font stack, and literal colours in the icon, Apple icon, Open Graph image, web manifest and the network SVG.

## Decision
1. **Same shared kit.** `app/layout.tsx` imports `@bedbanks/ui/src/brand-tokens.css` and the self-hosted `@fontsource` Poppins and IBM Plex Mono files (ADR 0103). The website now depends on `@bedbanks/ui`.
2. **Same colour policy.** Raw hex in `globals.css` was rewritten by the ADR 0103 codemod to `var(--fb-*)`. The Tailwind `@theme inline` palette points at kit primitives (brand = red-600, brand-dark = red-700, brand-soft = red-100, ink = ink-900, muted/panel = ink-100, border = ink-200, warning = mustard-500; the green "trust" colours become ink, per the kit's status palette). The marketing CTA (`.button-primary`) is mustard with ink text and a mustard-600 hover; the focus ring is ink (was green); gold accents are mustard; the eyebrow is the kit kicker (IBM Plex Mono, red-600, uppercase).
3. **Places CSS variables cannot reach** use the kit's literal values: the generated icon, Apple icon, Open Graph image and manifest (`#D71921` red, `#111111` ink, `#D4A017` mustard). The network diagram's SVG uses the variables.
4. **Fonts policy restated.** The old rule ("body font is a system stack; no font requests") existed to avoid remote font hosts. Self-hosted same-origin fonts keep that intent and the CSP (`font-src 'self' data:`), so `tests/fonts.test.ts` now asserts the body font is the kit display font with a generic fallback and that the kit imports no remote stylesheet, and `e2e/runtime-csp.spec.ts` asserts that every font request is same-origin (`/_next/static/`) and that the body renders Poppins.
5. **Contrast.** The page-wide axe check (WCAG 2.1 A/AA) caught footer text that the mapping had turned into `#6b6b6b` on ink (3.5:1); footer copy and labels are `ink-400` (6.5:1).

## Verified
Type-check, lint, unit tests (62), `pnpm check:links`, production build, `pnpm check:site`, and the website's Playwright suite (34 tests: axe on 12 pages, keyboard, lead form, CSP hydration and fonts) against the production build; plus a full-page screenshot review of the home page.

## Not done / known limits
- Only the home page was eyeballed; other pages share the same variables and pass axe.
- The brand wordmark (`fabbeds-logo*.svg`) is the supplied artwork and is not recoloured.
- Type scale is unchanged (families, weights and the kicker follow the kit; display sizes and uppercase titles do not).
- Playwright needs a browser build matching its version; in the cloud container I pointed it at the installed Chromium with a temporary local config (not committed).
