import type { MetadataRoute } from 'next'
import { publicRoutes } from '../lib/navigation'
import { contentLastUpdated } from '../lib/content-dates'
import { privacyPolicyApproved } from '../lib/legal-status'
import { siteConfig } from '../lib/site-config'

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.filter((path) => path !== '/portals' && (path !== '/privacy' || privacyPolicyApproved)).map((path) => ({ url: new URL(path, `${siteConfig.siteUrl}/`).toString(), ...(contentLastUpdated[path] ? { lastModified: contentLastUpdated[path] } : {}), changeFrequency: path === '/' ? 'weekly' : 'monthly', priority: path === '/' ? 1 : .7 }))
}
