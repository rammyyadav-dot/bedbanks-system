import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, Building2, Users, ShieldCheck, ScrollText, Hotel, BedDouble,
  Truck, Radar, Tags, CalendarRange, Wallet, Bell, BarChart3, Settings,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; }
export interface NavSection { label?: string; items: NavItem[]; }

export const navSections: NavSection[] = [
  { items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    label: 'Business',
    items: [
      { href: '/tenants', label: 'Tenants', icon: Building2 },
      { href: '/users', label: 'Users', icon: Users },
      { href: '/access', label: 'Roles & Permissions', icon: ShieldCheck },
      { href: '/audit', label: 'Audit', icon: ScrollText },
    ],
  },
  {
    label: 'Hotel Supply',
    items: [
      { href: '/hotels', label: 'Hotels', icon: Hotel },
      { href: '/rooms', label: 'Rooms', icon: BedDouble },
    ],
  },
  {
    label: 'Suppliers',
    items: [
      { href: '/suppliers', label: 'Suppliers', icon: Truck },
      { href: '/contracts', label: 'Contracts', icon: ScrollText },
    ],
  },
  {
    label: 'Distribution',
    items: [
      { href: '/distribution', label: 'Search Monitor', icon: Radar },
      { href: '/inventory', label: 'Inventory', icon: CalendarRange },
      { href: '/rates', label: 'Rates', icon: Tags },
    ],
  },
  { label: 'Pricing', items: [{ href: '/pricing', label: 'Pricing Simulator', icon: Tags }] },
  {
    label: 'Bookings',
    items: [
      { href: '/bookings', label: 'All Bookings', icon: CalendarRange },
      { href: '/cancellations', label: 'Cancellations', icon: CalendarRange },
    ],
  },
  { label: 'Finance', items: [{ href: '/finance', label: 'Finance', icon: Wallet }] },
  { label: 'Communications', items: [{ href: '/notifications', label: 'Notifications', icon: Bell }] },
  { label: 'Reports', items: [{ href: '/reports', label: 'Reports', icon: BarChart3 }] },
  { label: 'Settings', items: [{ href: '/settings', label: 'Settings', icon: Settings }] },
];

export const flatNav = navSections.flatMap((s) => s.items);
