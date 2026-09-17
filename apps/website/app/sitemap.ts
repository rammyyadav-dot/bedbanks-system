import type { MetadataRoute } from 'next'
import { publicRoutes } from '../lib/navigation'
import { siteConfig } from '../lib/site-config'

export default function sitemap(): MetadataRoute.Sitemap {
  const contentDate = new Date('2026-09-17T00:00:00.000Z')
  return publicRoutes.filter((path) => path !== '/portals').map((path) => ({ url: new URL(path, `${siteConfig.siteUrl}/`).toString(), lastModified: contentDate, changeFrequency: path === '/' ? 'weekly' : 'monthly', priority: path === '/' ? 1 : .7 }))
}
