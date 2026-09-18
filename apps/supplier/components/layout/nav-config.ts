import type { LucideIcon } from 'lucide-react'
import {
  BadgePercent,
  BarChart3,
  BedDouble,
  BookOpenCheck,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardCheck,
  FileCheck2,
  LayoutDashboard,
  ReceiptText,
  SlidersHorizontal,
  Tags,
  TicketCheck,
  TriangleAlert,
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
  {
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/supplier-profile', label: 'Supplier profile', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Portfolio',
    items: [
      { href: '/properties', label: 'Properties', icon: Building2 },
      { href: '/contracts', label: 'Contracts', icon: BookOpenCheck },
      { href: '/rooms', label: 'Rooms', icon: BedDouble },
      { href: '/rates', label: 'Rates', icon: Tags },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/inventory', label: 'Inventory submissions', icon: ClipboardCheck },
      { href: '/availability', label: 'Availability', icon: CalendarDays },
      { href: '/allotments', label: 'Allotments', icon: FileCheck2 },
      { href: '/promotions', label: 'Promotions', icon: BadgePercent },
      { href: '/restrictions', label: 'Restrictions', icon: TriangleAlert },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/bookings', label: 'Bookings', icon: Boxes },
      { href: '/vouchers', label: 'Vouchers', icon: TicketCheck },
      { href: '/invoices', label: 'Invoices', icon: ReceiptText },
      { href: '/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
]

export const flatNav = navSections.flatMap((section) => section.items)
export const contextIcon = SlidersHorizontal
