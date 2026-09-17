import type { Metadata } from 'next'
import { siteConfig } from './site-config'

export type PageMetadataInput = { title: string; description: string; path: string }
export function pageMetadata({ title, description, path }: PageMetadataInput): Metadata {
  const canonical = new URL(path, `${siteConfig.siteUrl}/`).toString()
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: canonical, siteName: siteConfig.brandName, type: 'website', images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'fBeds hotel distribution platform' }] },
    twitter: { card: 'summary_large_image', title, description, images: ['/opengraph-image'] },
  }
}
