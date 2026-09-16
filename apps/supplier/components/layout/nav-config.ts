import type { LucideIcon } from 'lucide-react'
import {
  BadgeDollarSign,
  BedDouble,
  BookOpenCheck,
  Boxes,
  Building2,
  CalendarDays,
  CircleHelp,
  LayoutDashboard,
  Link2,
  Settings,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

export interface NavSection {
  label?: string
  items: NavItem[]
}

export const navSections: NavSection[] = [
  { items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    label: 'Supply',
    items: [
      { href: '/properties', label: 'Properties', icon: Building2 },
      { href: '/rooms-content', label: 'Rooms & Content', icon: BedDouble },
      { href: '/contracts-rate-plans', label: 'Contracts & Rate Plans', icon: BookOpenCheck },
      { href: '/availability-inventory', label: 'Availability & Inventory', icon: CalendarDays },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/bookings', label: 'Bookings', icon: Boxes },
      { href: '/finance', label: 'Finance', icon: BadgeDollarSign },
      { href: '/connectivity', label: 'Connectivity', icon: Link2 },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/team', label: 'Team & Access', icon: UsersRound },
      { href: '/support', label: 'Support', icon: CircleHelp },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

export const flatNav = navSections.flatMap((section) => section.items)
export const contextIcon = SlidersHorizontal
