# CTO Audit Report

**Repository:** `rammyyadav-dot/bedbanks-system`
**Audited commit:** `695abb1` (`v0/public-fbeds-website-aeb0445d`)
**Audit date:** 2026-09-16
**Scope:** authoritative monorepo structure, application ownership, UI implementation, build orchestration, and deployment readiness.

## Executive summary

The repository is a pnpm workspace monorepo with four Next.js applications and one NestJS API. The current architecture is directionally sound: public website, B2B agent portal, enterprise admin, supplier portal, and API are separated under `apps/*`, with reusable packages under `packages/*`.

The primary CTO-level risks are consistency and production hardening rather than missing application boundaries. The Website has a coherent public-facing visual system, while Agent and Admin use a separate operational design language. Supplier is currently a structural shell. Several applications still use mock or local data surfaces, and the root scripts only make Website the default production build. Deployment must therefore explicitly select the intended app or use a workspace-aware build command.

## Authoritative architecture

```text
bedbanks-system/
├── apps/
│   ├── website/   Public fBeds marketing website
│   ├── agent/     B2B hotel search and booking portal
│   ├── admin/     Enterprise operations console
│   ├── supplier/  Supplier/extranet portal shell
│   └── api/       NestJS API and Prisma boundary
├── packages/
│   ├── config/    Shared configuration contracts
│   ├── types/     Shared domain types
│   ├── ui/        Shared UI primitives
│   └── validation/Shared validation contracts
├── docs/          Technical and CTO audit documentation
├── package.json   Workspace orchestration
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── turbo.json
```

### Ownership map

| Capability | Authoritative location | Status |
|---|---|---|
| Public website | `apps/website` | Active Next.js application |
| Agent portal | `apps/agent` | Active Next.js application |
| Admin console | `apps/admin` | Active Next.js application with broad route coverage |
| Supplier portal | `apps/supplier` | Structural Next.js shell; feature work remains |
| API | `apps/api` | NestJS source under `src/`; Prisma/database boundary retained |
| Shared UI | `packages/ui` | Small shared primitive surface |
| Shared types | `packages/types` | Shared contract entrypoint |
| Shared config | `packages/config` | Shared configuration entrypoint |
| Shared validation | `packages/validation` | Shared validation entrypoint |

## File locations

### Website

- App routes: `apps/website/app/`
- Global UI styles: `apps/website/app/globals.css`
- Shared site composition: `apps/website/app/components/site.tsx`
- Metadata/layout: `apps/website/app/layout.tsx`
- Middleware: `apps/website/middleware.ts`
- Next config: `apps/website/next.config.ts`
- Main routes: `/`, `/about`, `/platform`, `/solutions`, `/supplier`, `/agent`, `/inventory`, `/resources`, `/contact`, `/request-demo`, `/admin`

### Agent

- Main portal screen: `apps/agent/app/page.tsx`
- Primary UI implementation: `apps/agent/components/agent-portal.tsx`
- Global styles and tokens: `apps/agent/app/globals.css`
- Hotel domain model: `apps/agent/types/hotel.ts`
- Service abstraction: `apps/agent/services/hotel-service.ts`
- Route: `/`

### Admin

- Dashboard route group: `apps/admin/app/(dashboard)/`
- Shell: `apps/admin/components/layout/AdminShell.tsx`
- Sidebar and navigation: `apps/admin/components/layout/Sidebar.tsx`, `nav-config.ts`
- Topbar: `apps/admin/components/layout/Topbar.tsx`
- Reusable data UI: `apps/admin/components/tables/`, `components/common/`, `components/status/`, `components/forms/`
- Auth UI and session files: `apps/admin/components/auth/`, `apps/admin/lib/auth/`, `apps/admin/middleware.ts`
- Global styles: `apps/admin/app/globals.css`

Admin route coverage includes dashboard, hotels, rooms, rates, inventory, suppliers, bookings, cancellations, distribution, finance, contracts, pricing, reports, notifications, settings, users, tenants, access, and audit.

### Supplier

- Page: `apps/supplier/app/page.tsx`
- Layout: `apps/supplier/app/layout.tsx`
- Next config: `apps/supplier/next.config.mjs`
- Environment contract: `apps/supplier/.env.example`
- Status: shell only; no mature supplier workflow components are currently present.

### API and data boundary

- NestJS source: `apps/api/src/`
- Auth: `apps/api/src/auth/`
- Database module: `apps/api/src/database/`
- Health endpoint: `apps/api/src/health/`
- Cross-cutting concerns: `apps/api/src/common/`
- Prisma seed: `apps/api/prisma/seed.ts`
- Generated output: `apps/api/dist/`

The API boundary remains separate from frontend route handlers. This is the correct ownership model for an enterprise platform and should be preserved.

## UI and design audit

### Website UI

The Website uses a light, premium B2B visual system:

- Primary brand red: `#D90429`
- Dark ink: `#1F2937`
- Soft cloud/panel surfaces: `#F9FAFB`, `#F3F4F6`
- Trust green: `#10B981`
- Warning amber: `#FF9F1C`
- White canvas with thin neutral borders
- Inter-based sans typography
- Wide centered container: approximately `1180px`
- Editorial grid-line and network-line motifs
- Responsive layout with reduced motion support and visible focus treatment

The public website is visually coherent and commercially legible. The main follow-up opportunity is to replace generic or placeholder media with a governed hospitality image system and connect CTA destinations to production workflows.

### Agent UI

The Agent portal has a distinct operational bedbank language:

- Navy shell: approximately `#0E2530` / `#0D2631`
- Cyan action color: approximately `#18BED0` / `#149DAC`
- Barlow Semi Condensed for compact operational copy
- Montserrat for headings and metric emphasis
- Dense hotel search form and result-card layout
- Calendar popover with check-in/check-out tabs and range selection
- Filter rail and hotel result cards
- Responsive breakpoint around `850px`

This is appropriate for high-density B2B workflows. The main risk is style concentration in a large `agent-portal.tsx` and large CSS file, which increases regression risk as real API behavior and booking flows are added.

### Admin UI

Admin uses the same dark navy/cyan operational family as Agent, with a more enterprise-oriented shell:

- Fixed sidebar navigation
- Tenant/context switcher
- Topbar with environment and user controls
- KPI cards, panels, tables, drawers, status badges, and confirmation dialogs
- Desktop-first dashboard grid with responsive behavior
- Authenticated route boundary via middleware and auth utilities

The component decomposition is materially stronger than Agent: layout, tables, forms, dialogs, status, and dashboard components are separated. The main concern is that many data surfaces are backed by `apps/admin/lib/mock/`, so production data-readiness must be tracked explicitly.

### Supplier UI

Supplier currently has minimal UI: a branded shell/page rather than an operational extranet. It should not be represented as feature-complete. The next UI milestone should define supplier onboarding, property/content management, availability, rates, mapping, contracts, and support workflows before adding visual polish.

### Shared UI

`packages/ui` currently contains a small button/utils surface. It is not yet a complete design system. Website, Agent, and Admin each own substantial local styling and tokens. This is acceptable while product surfaces are evolving, but shared primitives should be extracted only where interaction and visual behavior are demonstrably stable.

## Build and deployment audit

Root orchestration currently identifies Website as the default application:

```json
{
  "dev": "pnpm --filter @bedbanks/website dev",
  "build": "pnpm --filter @bedbanks/website build",
  "build:all": "pnpm -r --if-present build",
  "type-check": "pnpm -r --if-present type-check"
}
```

This is safe for a Website Vercel project only when the Vercel project root/build settings match the repository root and the root build output is produced by Website. Agent, Admin, and Supplier deployments should use their package filters or configured project root directories rather than assuming a root Next.js app.

`turbo.json` includes `.next/**`, `dist/**`, and `build/**` task outputs. This is appropriate for workspace caching. Generated `apps/api/dist/` files exist and should remain build artifacts, not source-of-truth implementation.

## Findings and risks

### High priority

1. **Deployment target ambiguity** — Multiple Next.js apps exist, but the root build targets Website. Each Vercel project must explicitly identify its app or use an app-specific build command.
2. **Supplier feature gap** — Supplier is only a shell and should be treated as a roadmap placeholder, not a production portal.
3. **Mock data in Admin** — `apps/admin/lib/mock/` indicates many admin screens are not yet connected to the NestJS API.
4. **API integration depth** — Agent has a service abstraction, but production search, booking, cancellation, and inventory contracts must be connected and validated end-to-end.

### Medium priority

5. **Large Agent component surface** — `apps/agent/components/agent-portal.tsx` owns substantial interaction and presentation logic. Split by workflow after API contracts stabilize.
6. **Duplicated local design tokens** — Website, Agent, and Admin have intentionally different palettes, but typography and spacing primitives are locally repeated.
7. **Shared packages are early-stage** — `packages/ui`, `packages/types`, `packages/config`, and `packages/validation` need clear contribution and dependency rules.
8. **Build artifact hygiene** — Keep generated `dist/` and `.next/` outputs out of source review and deployment commits unless explicitly required by the deployment system.

### Low priority

9. **Root scripts lack explicit `dev:website` alias** — `dev` is clear, but an explicit alias would improve discoverability for teams operating multiple apps.
10. **No unified observability section** — API health exists, but app-level error tracking, audit events, and deployment telemetry should be documented as a platform concern.

## Recommended sequence

1. Lock Vercel project-to-app ownership for Website, Agent, Admin, Supplier, and API.
2. Define production API contracts for search, hotel detail, rates, booking, cancellation, and supplier inventory.
3. Replace Admin mock repositories behind stable service interfaces, without changing UI routes.
4. Build Supplier workflows from domain contracts rather than copying Agent UI.
5. Split Agent into search, filters, calendar, rooms, hotel results, and booking components after behavior is covered by tests.
6. Extract only stable primitives into `packages/ui`; avoid a premature universal design system.
7. Add CI matrix validation for every app/package: install, type-check, lint, test, and build.
8. Add deployment runbooks documenting project root, install command, build command, output directory, environment variables, and rollback procedure.

## Validation status

Read-only audit evidence at the audited commit:

- Git branch and commit inspected.
- Workspace manifests inspected.
- App route and component inventories inspected.
- Website, Agent, and Admin global styles inspected.
- API source and generated output locations inspected.
- Root workspace and Turbo configuration inspected.
- No product code, database schema, authentication, or deployment configuration was modified for this report.

A full build matrix should be run in CI or a deployment environment after any structural change. The audit intentionally does not claim runtime behavior beyond the inspected source and existing workspace configuration.

## CTO decision summary

**Architecture decision:** Keep the pnpm monorepo and current app boundaries.
**Frontend decision:** Continue separate Website, Agent, Admin, and Supplier applications with selective shared packages.
**Backend decision:** Keep NestJS and Prisma as the API/data boundary.
**UI decision:** Preserve distinct public marketing and operational product systems; extract shared components only after usage stabilizes.
**Deployment decision:** Configure one Vercel project per independently deployed app, or explicitly target the intended workspace from the repository root.

**Overall assessment:** structurally sound foundation, with production readiness depending on API integration, Supplier implementation, mock-data removal, deployment targeting, and automated validation coverage.
