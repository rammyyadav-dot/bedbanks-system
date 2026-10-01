import type { Metadata } from 'next'
import { connection } from 'next/server'
import { Analytics } from '@vercel/analytics/next'
import { siteConfig } from '../lib/site-config'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.siteUrl),
  title: { default: siteConfig.defaultTitle, template: `%s | ${siteConfig.brandName}` },
  description: siteConfig.defaultDescription,
  alternates: { canonical: '/' },
  openGraph: { title: siteConfig.defaultTitle, description: siteConfig.defaultDescription, url: '/', siteName: siteConfig.brandName, type: 'website', images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'fBeds hotel distribution platform' }] },
  twitter: { card: 'summary_large_image', title: siteConfig.defaultTitle, description: siteConfig.defaultDescription, images: ['/opengraph-image'] },
  icons: { icon: '/icon', apple: '/apple-icon' },
  manifest: '/manifest.webmanifest',
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonce-based CSP needs a per-request render, so every page is rendered on demand (ADR/README: CSP).
  await connection()
  const structuredData = [{ '@context': 'https://schema.org', '@type': 'Organization', name: siteConfig.brandName, url: siteConfig.siteUrl, email: siteConfig.contactEmail }, { '@context': 'https://schema.org', '@type': 'WebSite', name: siteConfig.brandName, url: siteConfig.siteUrl, description: siteConfig.defaultDescription }]
  return <html lang="en" className="bg-background"><body className="font-sans">{children}<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />{siteConfig.analyticsEnabled && <Analytics />}</body></html>
}
