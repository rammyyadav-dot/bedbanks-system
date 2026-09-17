import type { PortalKey } from './site-config'

export type NavigationItem = { label: string; href: string; description?: string }

export const primaryNavigation: NavigationItem[] = [
  { label: 'Solutions', href: '/solutions' },
  { label: 'Platform', href: '/platform' },
  { label: 'Inventory', href: '/inventory' },
  { label: 'Connectivity', href: '/connectivity' },
  { label: 'Resources', href: '/resources' },
  { label: 'Company', href: '/about' },
]

export const footerNavigation = {
  explore: primaryNavigation.slice(0, 5),
  company: [
    { label: 'About fBeds', href: '/about' },
    { label: 'Contact', href: '/contact' },
    { label: 'Request a demo', href: '/request-demo' },
  ],
} satisfies Record<string, NavigationItem[]>

export const publicRoutes = [
  '/', '/solutions', '/solutions/travel-agencies', '/solutions/tour-operators', '/solutions/dmcs',
  '/solutions/hotels', '/solutions/travel-technology', '/platform', '/inventory', '/connectivity',
  '/about', '/resources', '/contact', '/request-demo', '/portals',
] as const

export const portalLabels: Record<PortalKey, string> = {
  agent: 'Agent portal', supplier: 'Supplier portal', admin: 'Operations portal',
}
