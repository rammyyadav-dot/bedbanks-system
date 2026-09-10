import type { MetadataRoute } from 'next'
export default function sitemap(): MetadataRoute.Sitemap { return ['', '/about', '/technology', '/inventory', '/api', '/supplier', '/agent', '/pricing', '/contact', '/careers', '/resources', '/request-demo'].map((path) => ({ url: `https://fbeds-website.vercel.app${path}`, lastModified: new Date() })) }
