# fBeds Public Website UI/UX CTO Audit

**Repository:** `rammyyadav-dot/bedbanks-system`
**Scope:** Public marketing website only (`apps/website`)
**Audit date:** 2026-09-18
**Audit type:** Read-only architecture, UI/UX, conversion, accessibility, SEO, performance, and launch-readiness review

## Executive verdict

**Current readiness: Needs revision.**

The website has a coherent public-site shell, a clear fBeds visual direction, a usable App Router page set, and a strong first-pass B2B positioning system. It is not yet ready for an unqualified public launch because several navigation destinations are missing, the primary conversion path is only a mailto placeholder, metadata is tied to a Vercel preview hostname, and the public website does not yet demonstrate production-grade form, trust, legal, or measurement states.

**Readiness score: 6/10.**

### Top five release blockers

1. **Broken or missing routes:** Header/footer reference `/login`, `/careers`, and `/privacy`, but those pages are not present in the website route map. This creates dead-end navigation.
2. **Conversion form is not implemented:** `/request-demo` links to `mailto:hello@fbeds.com` rather than a validated form with success, error, privacy consent, spam protection, and ownership routing.
3. **Preview-host metadata:** `metadataBase`, Open Graph URL, and footer hostname use `fbeds-website.vercel.app`; production canonical configuration is not established.
4. **Unverified claims and placeholder operating proof:** Copy references global inventory, live infrastructure, real-time distribution, and booking confidence without a visible proof/evidence model. These claims require business verification before publication.
5. **Portal routing is explanatory, not operational:** Public `/agent`, `/supplier`, and `/admin` pages are portal shells within the website app; the audited implementation does not establish authenticated cross-app routing or production portal URLs.

### Highest-impact improvements

1. Make the home hero explicitly identify fBeds as a B2B hotel bedbank marketplace and clarify buyer/supplier audiences in the first viewport.
2. Replace mailto conversion with a proper request-demo flow and measurable CTA events.
3. Resolve all navigation destinations and publish legal/contact routes.
4. Add verified trust proof, partner workflow explanation, and API/connectivity detail without inventing statistics.
5. Complete technical SEO, production metadata, sitemap/robots, structured data, and image/font performance work.

### Priority order

- **P0:** Route integrity, conversion form, production metadata, claims verification, portal destination ownership, legal/privacy surface.
- **P1:** Hero and audience messaging, buyer/supplier solution sections, connectivity proof, trust section, FAQ, responsive/accessibility hardening.
- **P2:** Resources/content engine, analytics experimentation, schema expansion, performance budgets, partner proof library, growth SEO.

## Repository and route audit

### Authoritative location

- Website app: `apps/website/`
- App Router pages: `apps/website/app/**/page.tsx`
- Shared website UI: `apps/website/app/components/site.tsx`
- Website styles/tokens: `apps/website/app/globals.css`
- Root layout/metadata: `apps/website/app/layout.tsx`
- Website package scripts: `apps/website/package.json`

The public site remains correctly isolated from Agent, Admin, Supplier, NestJS, Prisma, authentication, and database code.

### Current public route map

| Route | File | Current role | Status |
|---|---|---|---|
| `/` | `apps/website/app/page.tsx` | Main marketing homepage | Present; needs conversion and proof refinement |
| `/about` | `apps/website/app/about/page.tsx` | Company page | Present |
| `/contact` | `apps/website/app/contact/page.tsx` | Contact content page | Present; likely needs real contact workflow |
| `/inventory` | `apps/website/app/inventory/page.tsx` | Inventory proposition | Present |
| `/platform` | `apps/website/app/platform/page.tsx` | Platform proposition | Present |
| `/request-demo` | `apps/website/app/request-demo/page.tsx` | Demo CTA | Present; mailto placeholder |
| `/resources` | `apps/website/app/resources/page.tsx` | Resources proposition | Present; no visible content index |
| `/solutions` | `apps/website/app/solutions/page.tsx` | Solutions proposition | Present |
| `/agent` | `apps/website/app/agent/page.tsx` | Agent portal landing/shell | Present; destination contract unclear |
| `/supplier` | `apps/website/app/supplier/page.tsx` | Supplier portal landing/shell | Present; destination contract unclear |
| `/admin` | `apps/website/app/admin/page.tsx` | Operations portal landing/shell | Present; should not imply public admin access |
| `/login` | Referenced by `site.tsx` | Header sign-in | Missing route; blocker |
| `/careers` | Referenced by `site.tsx` | Footer company link | Missing route; blocker |
| `/privacy` | Referenced by `site.tsx` | Footer legal link | Missing route; blocker |

### Shared UI and design implementation

`apps/website/app/components/site.tsx` owns the reusable public-site system:

- `Header`, `Footer`, `Logo`
- `PageFrame`, `PortalFrame`
- `SectionHeading`, `CTA`
- `LinkButton`, `MoreLink`, `BulletList`
- `NetworkVisual`
- Shared navigation items and page copy

This is a reasonable single-app boundary for the current site size. The next step should be selective extraction of stable primitives, not a cross-app shared UI rewrite.

`apps/website/app/globals.css` owns the primary tokens and global behavior:

- fBeds red `#d90429`
- dark ink and neutral surfaces
- green trust accent `#10b981`
- border, panel, muted, warning, and focus tokens
- responsive container width
- grid-line and network animation utilities
- reduced-motion handling

`layout.tsx` loads Inter through `next/font/google`. The requested brand direction allows Inter for body/UI; major-heading differentiation with Montserrat or a local equivalent remains an open design decision.

### Route and dependency risks

- The website package uses Next.js 16, React 19, Tailwind 4, Lucide, and Vercel Analytics.
- `apps/website/package.json` declares `lint: eslint .`, but lint availability/configuration must be verified in the workspace before launch.
- Existing generated `.next` artifacts should not be treated as source or committed deployment dependencies.
- No public website API integration was identified in the audited surface; this is acceptable for a static marketing pass, but demo/contact handling is not production complete.

## Hero-section audit

### What works

- The first screen has a clear visual hierarchy: eyebrow, large headline, body, CTA pair, proof bullets, and network visual.
- The color system is disciplined and recognizably fBeds.
- The network visual communicates a marketplace/control-layer concept better than a generic travel image.
- Focus-visible and reduced-motion global behavior are present.

### Gaps

- The headline, “Connect the world’s hotels to the buyers who move it,” is strong but does not explicitly say “bedbank” or “B2B marketplace” within five seconds.
- The audience is implied rather than named in the hero. Buyers, suppliers, DMCs, OTAs, and travel technology should be explicit nearby.
- “See FBEDS in action” is commercially understandable, but “Explore fBeds” or “Request a demo” should be tested against the actual sales motion.
- “Live infrastructure” is a potentially unverified operational claim and should be verified or softened.
- The SVG is accessible with a useful ARIA label, but the hero has no photographic or hospitality-specific visual evidence. This may be appropriate for a systems brand, but should be an intentional choice.
- Mobile layout needs browser verification at 320px and 375px; the current grid and large type could create excessive vertical length.

### Recommended hero

- **Eyebrow:** Global B2B Hotel Distribution
- **Headline:** Connecting global hotel supply with global travel demand.
- **Body:** fBeds helps travel businesses source, distribute and sell worldwide accommodation through one connected B2B marketplace.
- **Primary CTA:** Explore fBeds
- **Secondary CTA:** Become a Partner
- Add a compact audience row: Travel agencies · DMCs · Wholesalers · Hotels · Travel technology.
- Keep the network visual, but label every claim as a conceptual network unless live status can be verified.

## Content and conversion audit

| Area | Current issue | Business impact | Recommended change | Priority |
|---|---|---|---|---|
| Homepage positioning | Bedbank category is not explicit enough | Visitors may not understand the commercial model | Add “B2B hotel bedbank marketplace” to eyebrow/body | P0 |
| Buyer solution | Audience benefits are not sufficiently segmented | Buyers cannot quickly self-identify | Add buyer outcomes: source, compare, book, distribute | P1 |
| Supplier solution | Supplier route exists, but value proposition is thin | Supply partners lack a clear reason to engage | Add distribution reach, control, content, rate and booking workflow messaging | P1 |
| Connectivity | API/XML is named but not demonstrated | Technical buyers cannot assess fit | Add an API/connectivity section with verified capabilities only | P1 |
| Proof | No verified customer, coverage, booking, or performance proof | Enterprise trust is limited | Add a proof framework; publish only approved facts | P0 |
| Demo conversion | Mailto is used instead of a form | Tracking, qualification, and error handling are absent | Build a form with validation, consent, success/error states, and routing | P0 |
| Portal routing | Portal pages do not establish production destinations | Users may land in the wrong system | Define canonical Agent/Supplier/Admin URLs and show role-specific CTAs | P0 |
| FAQ | No clear FAQ content index is visible | Objections remain unanswered | Add buyer, supplier, connectivity, and onboarding FAQs | P1 |
| Final CTA | CTA exists but is generic | Weakens end-of-page conversion | Use “Request platform access” or “Talk to distribution” based on sales flow | P1 |
| Legal | Privacy route is linked but missing | Compliance and trust risk | Add privacy, terms, cookie/consent policy as applicable | P0 |
| Resources | Resources page is primarily positioning copy | Low organic/content value | Add real articles or keep the route clearly “coming soon” | P2 |

### Audience conversion paths

- **Buyer:** Home → Solutions → Platform/Inventory → Request demo → qualified sales handoff.
- **Supplier:** Home → Supplier solution → Supplier portal or partner form → onboarding handoff.
- **Travel technology:** Home → Platform → Connectivity/API proof → technical conversation.
- **Operations/Admin:** Do not promote `/admin` as a public product CTA unless there is a controlled authenticated destination.

## UI and visual-design audit

### Strengths

- Strong red/black/white discipline with green reserved for trust/status.
- Consistent small-radius buttons and bordered panel language.
- Good editorial headline scale and generous page spacing.
- Network visual gives the brand a systems-oriented identity.
- Global focus ring and reduced-motion behavior are good foundations.

### Production gaps

- Navigation has no visible mobile menu implementation in the audited shared header; the desktop nav is hidden below `lg`, leaving only logo and CTA on smaller screens.
- Header does not expose a clear menu button or mobile navigation state.
- Footer links include missing destinations.
- Button states are mostly hover-only; loading, disabled, focus, and error states are not represented in the marketing conversion path.
- Many content pages reuse a generic `ContentPage`, which keeps consistency but risks making the public site feel templated rather than product-specific.
- The admin portal link in a public footer could create security and positioning confusion.
- No image asset strategy is visible in the audited homepage; if imagery is introduced, use `next/image`, meaningful alt text, responsive sizing, and explicit focal-point crops.

### Responsive and accessibility risks

- Test the header at 320px, 375px, 768px, and desktop; confirm navigation remains usable without horizontal overflow.
- Maintain a single logical H1 per route and verify heading order in reusable page compositions.
- Add labels and errors for every future form field; do not rely on placeholder text alone.
- Preserve visible focus for links, buttons, and form controls.
- Validate red text and muted gray text against white and dark backgrounds with a contrast tool.
- Mark decorative SVGs as decorative only when the adjacent copy fully conveys their meaning.

## Accessibility, SEO, and performance audit

### Current positives

- `lang="en"` is set.
- Semantic `header`, `nav`, `main`, and `footer` elements are used.
- Logo has an accessible label.
- Network SVG has an ARIA role and label.
- Global `:focus-visible` and reduced-motion rules are present.
- `next/font/google` avoids an unstyled default webfont request pattern.

### P0 SEO work

- Replace preview `metadataBase` with the production canonical domain once confirmed.
- Add route-specific titles and descriptions rather than relying only on the root title template.
- Add canonical URLs for the homepage and key commercial pages.
- Add Open Graph image, Twitter card metadata, and a stable social preview asset.
- Add `app/robots.ts` and `app/sitemap.ts` for the public website.
- Add a favicon and consistent brand icon metadata.
- Add Organization and WebSite JSON-LD; consider SoftwareApplication only if the platform is genuinely presented as software and claims are verified.
- Ensure `/admin`, `/agent`, and `/supplier` public shells are intentionally indexed or marked appropriately.

### Performance risks

- Verify no large raster assets are loaded above the fold.
- Keep the network visual inline and lightweight; avoid adding heavy animation libraries.
- Respect reduced motion for the animated network paths.
- Set performance budgets for LCP, CLS, and INP before adding third-party analytics or marketing scripts.
- Load only the required font weights.
- Confirm Vercel Analytics does not introduce blocking or privacy/compliance concerns.

### Security and form basics

- Use a server-side form endpoint or approved form provider; never expose secrets in client code.
- Validate and sanitize all submitted fields server-side.
- Add anti-spam controls and rate limiting appropriate to the selected form architecture.
- Add explicit consent and privacy links where personal data is collected.
- Use safe external-link behavior and avoid claiming portal authentication from a public shell.

## Launch acceptance criteria

- [ ] All header, footer, hero, and CTA routes resolve successfully.
- [ ] `/login`, `/careers`, and `/privacy` are either implemented or removed from navigation.
- [ ] Canonical production domain is confirmed and applied to metadata.
- [ ] No placeholder copy, fake testimonials, invented customer names, or unverified statistics remain.
- [ ] Portal routes point to confirmed Agent, Supplier, and Admin destinations.
- [ ] Demo/contact form has validation, consent, success, error, and spam handling.
- [ ] Mobile layouts pass at 320px, 375px, 768px, and desktop widths.
- [ ] Keyboard navigation works with visible focus states.
- [ ] Heading hierarchy and landmark structure pass accessibility review.
- [ ] All meaningful images have alt text; decorative assets are correctly hidden from assistive technology.
- [ ] Contrast passes for body text, buttons, status colors, and footer text.
- [ ] Page titles, descriptions, canonical URLs, Open Graph, Twitter cards, favicon, robots, and sitemap are complete.
- [ ] No console errors occur across the public route map.
- [ ] Build, lint, and type-check pass for `apps/website`.
- [ ] Vercel production build succeeds with the correct monorepo project root/build command.
- [ ] Privacy, terms, cookie, and data-handling decisions are approved before collecting leads.

## Recommended implementation plan

### P0 — launch blockers

1. Resolve missing navigation routes and decide whether `/login`, `/careers`, and `/privacy` belong in the first release.
2. Confirm production domain and replace preview-host metadata.
3. Define canonical portal URLs and remove or gate public Admin routing.
4. Implement a real request-demo/contact form with validation, consent, success/error states, and server-side protection.
5. Review every operational claim with the business owner and mark unknowns for verification.
6. Add robots, sitemap, favicon, canonical metadata, and social preview metadata.

Likely files/routes: `apps/website/app/components/site.tsx`, `apps/website/app/layout.tsx`, new `apps/website/app/privacy/page.tsx`, `apps/website/app/careers/page.tsx` if approved, `apps/website/app/request-demo/page.tsx`, `apps/website/app/robots.ts`, `apps/website/app/sitemap.ts`, and website configuration.

### P1 — conversion and credibility

1. Rewrite hero and audience messaging around “The World’s Bedbank Marketplace.”
2. Add buyer, supplier, connectivity, proof, FAQ, and final CTA sections.
3. Add mobile navigation and complete button/form states.
4. Replace generic content-page repetition with role-specific commercial narratives.
5. Add approved enterprise trust signals and partner workflow diagrams.

Likely files/routes: `apps/website/app/page.tsx`, `apps/website/app/solutions/page.tsx`, `apps/website/app/platform/page.tsx`, `apps/website/app/inventory/page.tsx`, `apps/website/app/components/site.tsx`, `apps/website/app/globals.css`.

### P2 — growth and optimisation

1. Publish a real resources/content model.
2. Add approved structured data and internal-linking strategy.
3. Add analytics events and conversion funnel reporting.
4. Establish image, font, and Core Web Vitals budgets.
5. Run A/B tests on hero framing and CTA language after baseline tracking exists.

### Suggested reviewable commit sequence

1. `audit: resolve public route and portal contracts`
2. `feat(website): add production metadata and technical seo`
3. `feat(website): implement lead capture states`
4. `feat(website): clarify buyer and supplier conversion paths`
5. `feat(website): add trust, connectivity, faq and final cta sections`
6. `test(website): validate responsive accessibility and production build`

### Validation commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @bedbanks/website type-check
pnpm --filter @bedbanks/website lint
pnpm --filter @bedbanks/website build
```

Also run browser checks across the route map, mobile widths, keyboard navigation, CTA flows, and browser console output. Confirm the Vercel project root and build settings point to the website app or to the root orchestration that produces the website build.

## CEO summary

1. **Readiness score:** 6/10 — strong visual foundation, not launch-ready because route integrity, lead capture, production SEO, and proof verification remain incomplete.
2. **Three immediate actions:** fix dead links and portal contracts; replace mailto with a qualified demo form; confirm production domain/metadata and verify all commercial claims.
3. **Estimated scope:** Medium for launch readiness; large if a full content, trust, and measurement system is included.
4. **CEO decision required:** approve the production domain, canonical Agent/Supplier/Admin destinations, lead-routing owner, legal pages, and the set of verified marketplace/platform claims that may be published.

## Audit evidence and limitations

This is a source-level audit of the public website implementation. It intentionally does not modify product code or inspect private production analytics, CRM routing, live portal deployments, customer proof, legal approvals, or business-verified inventory metrics. Those items remain explicit launch dependencies.
