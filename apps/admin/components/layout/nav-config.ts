import type { LucideIcon } from 'lucide-react';
import { departments, sidebarGroups, type DepartmentPermission, type OperationsPermission, type SupplyPermission } from '@bedbanks/contracts';
import {
  LayoutDashboard, Hotel, Truck, Tags, CalendarRange, ShieldCheck, ScrollText, Settings, FileSignature, ClipboardCheck, Link2,
  BookOpen, Lock, Wrench, Globe, Activity, UserCheck, Percent, Users, LifeBuoy, EyeOff, Landmark, Receipt, BanknoteArrowDown, Hourglass, History, Cable, Gauge, Undo2, TriangleAlert,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; /** Hide the item when the caller lacks this permission (UX hint only). */ requires?: SupplyPermission | OperationsPermission | DepartmentPermission; }
export interface NavSection { label?: string; items: NavItem[]; }

const icons: Record<string, LucideIcon> = {
  '/dashboard': LayoutDashboard, '/exceptions': TriangleAlert, '/contracts': FileSignature, '/hotels': Hotel, '/mappings': Link2,
  '/suppliers': Truck, '/connectors': Cable, '/board-basis': Tags, '/rates/plans': ScrollText, '/rates': CalendarRange,
  '/sellability': ClipboardCheck, '/operations': Gauge, '/bookings': BookOpen, '/holds': Lock, '/cancellations': Undo2,
  '/reconciliation': Wrench, '/finance/wallets': Landmark, '/finance/ledger': Receipt, '/finance/funding': BanknoteArrowDown, '/finance/receivables': Hourglass, '/commercial/markups': Percent, '/clients/agencies': Users, '/service/cases': LifeBuoy, '/distribution/restrictions': EyeOff, '/markets': Globe, '/reliability': Activity, '/access-review': UserCheck, '/access': ShieldCheck, '/settings': Settings, '/audit': History,
};

/**
 * Enterprise department navigation (ADR 0015), derived from the department catalogue in `@bedbanks/contracts`.
 * Only `live` modules render: a planned module has no route, no API and no sidebar entry, so nothing here
 * presents a placeholder as a capability. A department with no live module does not appear at all.
 * `requires` hides an item the caller cannot use; it is a UX hint, the API is the authorizer.
 */
export const navSections: NavSection[] = sidebarGroups
  .map((group) => ({
    label: group.label,
    items: group.departments
      .flatMap((id) => departments.find((d) => d.id === id)?.modules ?? [])
      .filter((m): m is typeof m & { href: string } => m.readiness === 'live' && !!m.href)
      .map((m): NavItem => ({ href: m.href, label: m.label, icon: icons[m.href]!, requires: m.requires as NavItem['requires'] })),
  }))
  .filter((section) => section.items.length > 0);

/** Routes that stay reachable (and breadcrumbed) without a sidebar entry. */
const hiddenRoutes: NavItem[] = [
  { href: '/rooms', label: 'Rooms', icon: Hotel, requires: 'supply.rooms.read' },
  { href: '/inventory', label: 'Rates & Inventory', icon: CalendarRange },
];

export const flatNav = [...navSections.flatMap((s) => s.items), ...hiddenRoutes];

/** True when `href` is the best (longest) sidebar match for `pathname`, so /rates does not also light up under /rates/plans. */
export function isActiveRoute(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const matches = (h: string) => pathname === h || pathname.startsWith(`${h}/`);
  if (!matches(href)) return false;
  return !flatNav.some((other) => other.href.length > href.length && other.href.startsWith(href) && matches(other.href));
}
