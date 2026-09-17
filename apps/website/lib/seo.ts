import type { Metadata } from 'next'
import { siteConfig } from './site-config'

export function pageMetadata(title: string, description: string, path: string): Metadata {
  const canonical = new URL(path, `${siteConfig.siteUrl}/`).toString()
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: canonical, siteName: siteConfig.brandName, type: 'website' },
    twitter: { card: 'summary_large_image', title, description },
  }
}
