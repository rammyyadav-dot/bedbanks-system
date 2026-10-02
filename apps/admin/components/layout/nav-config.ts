import type { LucideIcon } from 'lucide-react';
import type { OperationsPermission, SupplyPermission } from '@bedbanks/contracts';
import {
  LayoutDashboard, Hotel, Truck, Tags, CalendarRange, ShieldCheck, ScrollText, Settings, FileSignature, ClipboardCheck, Link2,
  BookOpen, Lock, Wrench, Landmark, Receipt, History, Cable, Gauge, Undo2,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; /** Hide the item when the caller lacks this permission (UX hint only). */ requires?: SupplyPermission | OperationsPermission; }
export interface NavSection { label?: string; items: NavItem[]; }

/**
 * Dubai MVP navigation. Only modules backed by authoritative APIs are listed.
 * Operations views (bookings, holds, reconciliation, finance, audit, connectors) read the API's read-only
 * `/admin/operations/*` endpoints. Reports, notifications, tenants/users, distribution and the pricing simulator
 * are intentionally absent: their routes render an explicit "not enabled" state instead of data.
 */
export const navSections: NavSection[] = [
  { label: 'Overview', items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    label: 'Commercial',
    items: [
      { href: '/suppliers', label: 'Suppliers', icon: Truck, requires: 'supply.suppliers.read' },
      { href: '/hotels', label: 'Hotels', icon: Hotel, requires: 'supply.hotels.read' },
      { href: '/board-basis', label: 'Board Basis', icon: Tags, requires: 'supply.rates.read' },
      { href: '/mappings', label: 'Mappings', icon: Link2, requires: 'supply.mappings.read' },
      { href: '/contracts', label: 'Contracts', icon: FileSignature, requires: 'supply.contracts.read' },
      { href: '/rates/plans', label: 'Rate Plans', icon: ScrollText, requires: 'supply.rates.read' },
      { href: '/rates', label: 'Rates & Inventory', icon: CalendarRange, requires: 'supply.rates.read' },
      { href: '/sellability', label: 'Sellability', icon: ClipboardCheck, requires: 'supply.rates.read' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/operations', label: 'Readiness', icon: Gauge, requires: 'booking.read' },
      { href: '/bookings', label: 'Bookings', icon: BookOpen, requires: 'booking.read' },
      { href: '/holds', label: 'Inventory holds', icon: Lock, requires: 'booking.read' },
      { href: '/reconciliation', label: 'Reconciliation', icon: Wrench, requires: 'booking.reconcile' },
      { href: '/cancellations', label: 'Cancellations', icon: Undo2, requires: 'booking.cancel' },
      { href: '/connectors', label: 'Connectors', icon: Cable, requires: 'booking.read' },
    ],
  },
  {
    label: 'Finance & audit',
    items: [
      { href: '/finance/wallets', label: 'Wallets', icon: Landmark, requires: 'finance.read' },
      { href: '/finance/ledger', label: 'Ledger', icon: Receipt, requires: 'finance.read' },
      { href: '/audit', label: 'Audit explorer', icon: History, requires: 'audit.read' },
    ],
  },
  {
    label: 'Control',
    items: [
      { href: '/access', label: 'Roles & Permissions', icon: ShieldCheck },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

/** Routes that stay reachable (and breadcrumbed) without a sidebar entry. */
const hiddenRoutes: NavItem[] = [
  { href: '/rooms', label: 'Rooms', icon: Hotel, requires: 'supply.rooms.read' },
  { href: '/inventory', label: 'Rates & Inventory', icon: CalendarRange },
  { href: '/operations/hotels', label: 'Hotel readiness', icon: Hotel, requires: 'booking.read' },
];

export const flatNav = [...navSections.flatMap((s) => s.items), ...hiddenRoutes];

/** True when `href` is the best (longest) sidebar match for `pathname`, so /rates does not also light up under /rates/plans. */
export function isActiveRoute(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const matches = (h: string) => pathname === h || pathname.startsWith(`${h}/`);
  if (!matches(href)) return false;
  return !flatNav.some((other) => other.href.length > href.length && other.href.startsWith(href) && matches(other.href));
}
