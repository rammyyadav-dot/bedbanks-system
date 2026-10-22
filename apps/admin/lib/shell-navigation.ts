import { flatNav, navSections, type NavItem } from '@/components/layout/nav-config'

export interface Crumb { label: string; href?: string; current?: boolean }

const OPAQUE_ID = /^(?=.*\d)[A-Za-z0-9_-]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-/i

/** A readable label for a trailing path segment. Opaque identifiers are never echoed into the page chrome. */
export function humanizeSegment(segment: string): string {
  let value = segment
  try { value = decodeURIComponent(segment) } catch { /* keep the raw segment */ }
  if (OPAQUE_ID.test(value) || /^\d+$/.test(value)) return 'Details'
  const words = value.replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Details'
}

/** Admin › department › module › detail. Only the module is a link target; the department is a grouping with no route of its own. */
export function breadcrumbItems(pathname: string | null): Crumb[] {
  const path = pathname ?? '/dashboard'
  const match = flatNav
    .filter((item) => path === item.href || path.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]
  if (!match) return [{ label: 'Admin', href: '/dashboard' }, { label: 'Dashboard', current: true }]
  const group = navSections.find((section) => section.items.some((item) => item.href === match.href))?.label
  const rest = path.slice(match.href.length).split('/').filter(Boolean)
  const trail: Crumb[] = [{ label: 'Admin', href: '/dashboard' }]
  if (group && group !== match.label) trail.push({ label: group })
  if (rest.length === 0) return [...trail, { label: match.label, current: true }]
  return [...trail, { label: match.label, href: match.href }, { label: humanizeSegment(rest[rest.length - 1]!), current: true }]
}

/** Role-aware landing: the first module the caller may use, for when the requested page is denied. Null when nothing is permitted. */
export function firstAccessibleRoute(can: (permission: NonNullable<NavItem['requires']>) => boolean): string | null {
  const item = navSections.flatMap((section) => section.items).find((candidate) => !candidate.requires || can(candidate.requires))
  return item?.href ?? null
}
