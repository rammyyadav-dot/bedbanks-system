import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MarketLandingPage } from '@/components/marketing/landing-page'
import { MARKET_REGISTRY, MARKET_SLUGS, isMarketSlug } from '@/lib/landing-markets'

export const revalidate = 86_400 // ISR: content is static copy, so a daily revalidate is plenty

export function generateStaticParams() {
  return MARKET_SLUGS.map((market) => ({ market }))
}

export async function generateMetadata({ params }: { params: Promise<{ market: string }> }): Promise<Metadata> {
  const { market: slug } = await params
  if (!isMarketSlug(slug)) return {}
  const market = MARKET_REGISTRY[slug]
  return {
    title: market.metaTitle,
    description: market.metaDescription,
    alternates: { canonical: market.path },
    openGraph: {
      title: market.metaTitle,
      description: market.metaDescription,
      url: market.path,
      type: 'website',
      images: [{ url: market.heroImage.src }],
    },
    twitter: {
      card: 'summary_large_image',
      title: market.metaTitle,
      description: market.metaDescription,
      images: [market.heroImage.src],
    },
  }
}

export default async function MarketLandingRoute({ params }: { params: Promise<{ market: string }> }) {
  const { market: slug } = await params
  if (!isMarketSlug(slug)) notFound()
  const market = MARKET_REGISTRY[slug]

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: market.metaTitle,
    description: market.metaDescription,
    areaServed: market.region,
    provider: { '@type': 'Organization', name: 'fabBeds' },
    // Relative, not an absolute production domain: the public domain is not yet settled (see lib/marketplace-content.ts privacyLink).
    url: market.path,
  }

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
    <MarketLandingPage market={market} />
  </>
}
