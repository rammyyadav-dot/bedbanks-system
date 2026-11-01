import { resolveWebsiteConfig } from './config-utils'

const resolved = resolveWebsiteConfig({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_AGENT_URL: process.env.NEXT_PUBLIC_AGENT_URL,
  NEXT_PUBLIC_SUPPLIER_URL: process.env.NEXT_PUBLIC_SUPPLIER_URL,
  NEXT_PUBLIC_ADMIN_URL: process.env.NEXT_PUBLIC_ADMIN_URL,
  NEXT_PUBLIC_CONTACT_EMAIL: process.env.NEXT_PUBLIC_CONTACT_EMAIL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  VERCEL_URL: process.env.VERCEL_URL,
})

export const siteConfig = {
  brandName: 'fabbeds',
  legalName: 'fabbeds',
  siteUrl: resolved.siteUrl,
  contactEmail: resolved.contactEmail,
  defaultTitle: 'fabbeds | The World\'s Wholesale Marketplace',
  defaultDescription: 'fabbeds is building a connected B2B hotel distribution marketplace for hotels, accommodation suppliers, DMCs, bedbanks, travel agencies and tour operators.',
  analyticsEnabled: process.env.NODE_ENV === 'production',
  portals: resolved.portals,
} as const

export type PortalKey = keyof typeof siteConfig.portals

export function portalHref(portal: PortalKey): string {
  return siteConfig.portals[portal] ?? `/portals?target=${portal}`
}
