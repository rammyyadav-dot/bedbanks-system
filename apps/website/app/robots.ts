import type { MetadataRoute } from 'next'
import { siteConfig } from '../lib/site-config'
export default function robots(): MetadataRoute.Robots { return { rules: { userAgent: '*', allow: '/', disallow: ['/agent', '/supplier', '/admin', '/portals'] }, sitemap: new URL('/sitemap.xml', siteConfig.siteUrl).toString(), host: siteConfig.siteUrl } }
