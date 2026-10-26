import type { PortalKey } from './site-config'

export type NavigationItem = { label: string; href: string; description?: string }

export const primaryNavigation: NavigationItem[] = [
  { label: 'About fabbeds', href: '/about' },
  { label: 'Hotels & Suppliers', href: '/hotels-suppliers' },
  { label: 'Travel Buyers', href: '/travel-buyers' },
  { label: 'How It Works', href: '/how-it-works' },
  { label: 'Technology & Connectivity', href: '/connectivity' },
  { label: 'Contact Us', href: '/contact' },
]

export const footerNavigation = {
  explore: primaryNavigation.slice(1, 5),
  company: [
    { label: 'About fabbeds', href: '/about' },
    { label: 'Careers', href: '/careers' },
    { label: 'Contact', href: '/contact' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Register for Access', href: '/request-demo' },
  ],
} satisfies Record<string, NavigationItem[]>

export const publicRoutes = [
  '/', '/hotels-suppliers', '/travel-buyers', '/how-it-works', '/connectivity',
  '/about', '/contact', '/request-demo', '/login', '/careers', '/privacy', '/portals',
] as const

export const portalLabels: Record<PortalKey, string> = {
  agent: 'Agent portal', supplier: 'Supplier portal', admin: 'Operations portal',
}
