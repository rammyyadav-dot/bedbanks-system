import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, Building2, Users, ShieldCheck, ScrollText, Hotel, BedDouble,
  Truck, Radar, Tags, CalendarRange, Wallet, Bell, BarChart3, Settings,
} from 'lucide-react';

/** `live: false` marks routes that have no production API yet and render an unavailable state. */
export interface NavItem { href: string; label: string; icon: LucideIcon; live: boolean; }
export interface NavSection { label?: string; items: NavItem[]; }

export const navSections: NavSection[] = [
  { items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, live: true }] },
  {
    label: 'Business',
    items: [
      { href: '/tenants', label: 'Tenants', icon: Building2, live: true },
      { href: '/users', label: 'Users', icon: Users, live: false },
      { href: '/access', label: 'Roles & Permissions', icon: ShieldCheck, live: true },
      { href: '/audit', label: 'Audit', icon: ScrollText, live: false },
    ],
  },
  {
    label: 'Hotel Supply',
    items: [
      { href: '/hotels', label: 'Hotels', icon: Hotel, live: true },
      { href: '/rooms', label: 'Rooms', icon: BedDouble, live: true },
    ],
  },
  {
    label: 'Suppliers',
    items: [
      { href: '/suppliers', label: 'Suppliers', icon: Truck, live: true },
      { href: '/mappings', label: 'Mappings', icon: ShieldCheck, live: true },
      { href: '/contracts', label: 'Contracts', icon: ScrollText, live: true },
      { href: '/board-basis', label: 'Board Basis', icon: Tags, live: true },
    ],
  },
  {
    label: 'Distribution',
    items: [
      { href: '/distribution', label: 'Search Monitor', icon: Radar, live: false },
      { href: '/inventory', label: 'Inventory', icon: CalendarRange, live: true },
      { href: '/rates', label: 'Rates', icon: Tags, live: true },
    ],
  },
  { label: 'Pricing', items: [{ href: '/pricing', label: 'Pricing', icon: Tags, live: false }] },
  {
    label: 'Bookings',
    items: [
      { href: '/bookings', label: 'All Bookings', icon: CalendarRange, live: false },
      { href: '/cancellations', label: 'Cancellations', icon: CalendarRange, live: false },
    ],
  },
  { label: 'Finance', items: [{ href: '/finance', label: 'Finance', icon: Wallet, live: false }] },
  { label: 'Communications', items: [{ href: '/notifications', label: 'Notifications', icon: Bell, live: false }] },
  { label: 'Reports', items: [{ href: '/reports', label: 'Reports', icon: BarChart3, live: false }] },
  { label: 'Settings', items: [{ href: '/settings', label: 'Settings', icon: Settings, live: true }] },
];

export const flatNav = navSections.flatMap((s) => s.items);
