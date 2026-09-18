# Public fBeds Website Git File Location Audit

**Repository:** `rammyyadav-dot/bedbanks-system`
**Authoritative app:** `apps/website/`
**Audited branch:** `v0/audit-public-website`
**Audited commit:** `f0e11f2`
**Audit date:** 2026-09-18

## Executive summary

The public fBeds website is correctly isolated in `apps/website/` within the pnpm monorepo. Its App Router, metadata, styling, navigation, SEO files, middleware, and deployment configuration are all tracked under the website workspace. No public website implementation should be maintained in the repository root or in Agent, Admin, Supplier, or API workspaces.

## Canonical Git locations

| Concern | Authoritative path | Notes |
|---|---|---|
| Website workspace | `apps/website/` | Owns the public marketing application |
| Routes | `apps/website/app/**/page.tsx` | App Router route ownership |
| Shared site UI | `apps/website/app/components/site.tsx` | Header, Footer, Logo, CTA, page frames, shared visuals |
| Design tokens/styles | `apps/website/app/globals.css` | Public website typography, colors, layout, responsive rules |
| Root layout/SEO metadata | `apps/website/app/layout.tsx` | Metadata, viewport, global shell |
| Homepage | `apps/website/app/page.tsx` | Main public conversion surface |
| Website configuration | `apps/website/next.config.ts` | Next.js workspace configuration |
| PostCSS | `apps/website/postcss.config.mjs` | Tailwind/PostCSS pipeline |
| TypeScript | `apps/website/tsconfig.json` | Website compiler configuration |
| Runtime environment contract | `apps/website/.env.example` | Documented website variables only |
| Middleware | `apps/website/middleware.ts` | Website request/routing behavior |
| Sitemap | `apps/website/app/sitemap.ts` | Search engine route inventory |
| Robots | `apps/website/app/robots.ts` | Crawler policy |
| Package scripts | `apps/website/package.json` | Dev, build, type-check, lint, test |
| App guidance | `apps/website/AGENTS.md`, `apps/website/CLAUDE.md` | Workspace-specific engineering instructions |

## Current tracked route files

- `/` → `apps/website/app/page.tsx`
- `/about` → `apps/website/app/about/page.tsx`
- `/admin` → `apps/website/app/admin/page.tsx`
- `/agent` → `apps/website/app/agent/page.tsx`
- `/contact` → `apps/website/app/contact/page.tsx`
- `/inventory` → `apps/website/app/inventory/page.tsx`
- `/platform` → `apps/website/app/platform/page.tsx`
- `/request-demo` → `apps/website/app/request-demo/page.tsx`
- `/resources` → `apps/website/app/resources/page.tsx`
- `/solutions` → `apps/website/app/solutions/page.tsx`
- `/supplier` → `apps/website/app/supplier/page.tsx`

Referenced but not currently represented by a tracked page file: `/login`, `/careers`, and `/privacy`. These should be added or removed from navigation before public launch.

## Git ownership boundaries

| Workspace | Owns | Must not own public website UI |
|---|---|---|
| `apps/website` | Public fBeds marketing and portal-entry pages | — |
| `apps/agent` | B2B hotel search and booking operations | Yes |
| `apps/admin` | Enterprise administration and control plane | Yes |
| `apps/supplier` | Supplier/DMC operations | Yes |
| `apps/api` | NestJS API, Prisma, persistence boundary | Yes |
| `packages/*` | Reusable code only when genuinely shared | No app-specific page ownership |

## Root-level policy

The root is monorepo infrastructure. Public website files should not be added to root `app/`, `pages/`, `components/`, `lib/`, or root Next.js configuration. Root scripts may orchestrate workspaces, but the Website app must remain independently buildable from `apps/website`.

## Recent Git history

- `153816a` — Rebuild FBEDS website with portal subdomain routing
- `358fee1` — Fix env examples and HotelService demo mode
- `6444257` — Enforce workspace checks with PostgreSQL
- `f0e11f2` — Add public website CTO audit

Remote: `https://github.com/rammyyadav-dot/bedbanks-system.git`

## Findings

1. **Ownership is clear:** `apps/website` is the single authoritative public-site location.
2. **App-level config is correctly colocated:** Next, PostCSS, TypeScript, middleware, SEO, and env examples are inside the Website workspace.
3. **Navigation integrity needs follow-up:** `/login`, `/careers`, and `/privacy` are referenced without corresponding route files.
4. **Shared package discipline is appropriate:** Do not extract Website components into shared packages until another app has a real, stable use case.
5. **Deployment should target the Website workspace:** Vercel root directory should be `apps/website`, with build command `pnpm build` executed in that workspace or an equivalent workspace-aware command.

## Recommended actions

### P0

- Add the missing legal, careers, and login routes, or remove their links.
- Confirm Vercel project root directory and output settings point to `apps/website`.
- Keep production website changes scoped to `apps/website` and its explicitly required shared packages.

### P1

- Add a CI check that rejects root-level Next.js app files.
- Validate every internal navigation target against the App Router route map.
- Add ownership notes to pull requests touching more than one workspace.

### P2

- Add a generated route inventory to CI.
- Add a content and analytics governance checklist for marketing releases.

## Validation record

- `git status --short --branch`: clean at audit start.
- `git ls-files apps/website`: confirmed website files are tracked under `apps/website`.
- `git diff --check`: report changes are clean.
- Website package scripts are present for `dev`, `build`, `type-check`, `lint`, and `test`.

## Conclusion

The public fBeds website has a valid authoritative Git location: `apps/website/`. Preserve that boundary, deploy the Website workspace directly, and treat root-level public-site files as architectural drift requiring review.
