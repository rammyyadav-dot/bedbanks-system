import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['', '/solutions', '/platform', '/inventory', '/about', '/resources', '/contact', '/request-demo', '/agent', '/supplier', '/admin']
  return routes.map((path) => ({ url: `https://fbeds-website.vercel.app${path}`, lastModified: new Date() }))
}
