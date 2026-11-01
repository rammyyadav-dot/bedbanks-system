# ADR 0085: Admin shell navigation, breadcrumbs and theme tokens

Status: **Built (Admin UI only; no API, schema or contract change).**

## Audit of `apps/admin/app/(dashboard)` shell
The shell (layout, sidebar, topbar, route guard, capability provider) already existed (ADR 0015, 0063). Gaps found:
- Topbar and Sidebar labelled the user with `memberships[0]`, while capabilities and API calls use `pickActiveTenantId` (owner first). A multi-tenant user could see the wrong tenant and role beside the permissions actually applied.
- Breadcrumbs were plain text: no links, no department, no landmark, and raw record IDs were echoed into the chrome.
- A denied route was a dead end.
- The user menu ignored Escape and outside clicks; no skip link; no `aria-current` on the sidebar.
- Shell colours were hardcoded hex with no token layer; no `viewport` or title template.

## Decision
1. `activeMembership()` (next to `pickActiveTenantId`) is the one source for the tenant/role shown in the shell.
2. `lib/shell-navigation.ts`: `breadcrumbItems()` builds Admin › department › module › detail from the existing navigation (no second route table); opaque IDs render as "Details". `firstAccessibleRoute()` gives a denied page a link to the first module the caller may use.
3. Accessibility: skip link and focusable `main`, `nav aria-label="Breadcrumb"`, `aria-current`, Escape/outside-click dismissal for the user menu, Escape for the mobile drawer.
4. `components/layout/shell-theme.css` holds shell tokens; `app/layout.tsx` declares `viewport` (colour scheme, theme colour) and a title template.

## Unchanged (deliberately)
Authorization stays server-side; the route guard remains a UX control (ADR 0063). Tenant identity is still not chosen by the browser.

## Not done
- **Dark mode / theme switching.** `globals.css` (~110 KB) and the page components use hardcoded colours; a toggle would produce a half-dark console. It needs a token migration of the whole stylesheet first.
- **Tenant switcher.** Multi-tenant users stay on the owner-first default; a switcher needs a server-side, validated selection mechanism.
- Hotel layout (`HotelAdminHeader`) keeps its own header and does not render the shared breadcrumb.
- No browser walkthrough was run (no API/session available here).
