/**
 * Programmatic SEO landing pages for B2B source markets (ADR 0093).
 *
 * Static, hand-authored content only — generated per request from nothing, never scraped or templated into claims
 * the product can't back up. Copy follows the same constraint as the public home page (lib/marketplace-content.ts):
 * it describes capability, never invented volume, pricing advantage, testimonials or availability figures
 * (CLAUDE.md invariant 10). The CTA on every market page reuses the same access-request flow as /access — a
 * locally validated form that opens the visitor's email client. There is no separate lead-capture pipeline here.
 */

export type MarketSlug = 'uae' | 'uk' | 'thailand' | 'india-corporate'

export type MarketContent = {
  slug: MarketSlug
  path: `/b2b-hotel-supplier/${string}`
  /** Plain country/region name used in copy and JSON-LD. */
  region: string
  metaTitle: string
  metaDescription: string
  kicker: string
  headline: string
  lead: string
  /** What an agency based in or selling to this market actually gets — capability statements only. */
  points: Array<{ title: string; text: string }>
  heroImage: { src: string; alt: string }
}

export const MARKET_REGISTRY: Record<MarketSlug, MarketContent> = {
  uae: {
    slug: 'uae',
    path: '/b2b-hotel-supplier/uae',
    region: 'United Arab Emirates',
    metaTitle: 'B2B Hotel Supplier for UAE Travel Agencies | fabBeds',
    metaDescription: 'fabBeds is a wholesale hotel distribution platform for UAE-based travel agencies: search contracted inventory, compare rooms and boards, recheck price before you hold, and book against your agency credit.',
    kicker: 'UAE travel trade',
    headline: 'A wholesale hotel platform built for UAE travel agencies.',
    lead: 'Search contracted inventory, compare rooms and boards side by side, and confirm bookings against your agency credit — in one trade workspace.',
    points: [
      { title: 'Dirham-clear pricing', text: 'Stay totals shown in AED, with charges paid at the hotel listed separately.' },
      { title: 'Recheck before you hold', text: 'Price or availability changed since your search? You see it before anything is held, never after.' },
      { title: 'Credit you can see', text: 'Credit limit, balance and payment status in one view, with bank-transfer top-ups declared in the portal.' },
    ],
    heroImage: { src: '/dubai-marina-entrance.jpg', alt: 'Dubai marina waterfront in late afternoon light, with towers reflected in calm water.' },
  },
  uk: {
    slug: 'uk',
    path: '/b2b-hotel-supplier/uk',
    region: 'United Kingdom',
    metaTitle: 'B2B Hotel Supplier for UK Travel Agencies | fabBeds',
    metaDescription: 'fabBeds gives UK travel agencies a trade workspace for wholesale hotel distribution: contracted inventory, transparent room and board comparisons, and a recheck step before anything is held.',
    kicker: 'UK travel trade',
    headline: 'Wholesale hotel distribution for UK-based agencies.',
    lead: 'A trade workspace for agencies selling contracted hotel stock: compare rooms and cancellation terms, recheck before you hold, and keep every booking defensible.',
    points: [
      { title: 'Defensible bookings', text: 'Duplicate-booking checks, safe retries and an audit trail on every booking action.' },
      { title: 'Recheck before you hold', text: 'Re-price the selected rate against current inventory before anything is held — nothing is swapped silently.' },
      { title: 'Your own client mark-up', text: 'Add a display mark-up for your client on top of the stay total, kept separate from the booking itself.' },
    ],
    heroImage: { src: '/fabBeds-hero.png', alt: 'fabBeds trade workspace hero image.' },
  },
  thailand: {
    slug: 'thailand',
    path: '/b2b-hotel-supplier/thailand',
    region: 'Thailand',
    metaTitle: 'B2B Hotel Supplier for Thailand Travel Agencies | fabBeds',
    metaDescription: 'fabBeds connects Thailand-based travel agencies to contracted wholesale hotel inventory, with transparent pricing, a recheck step before every hold, and credit visibility in one workspace.',
    kicker: 'Thailand travel trade',
    headline: 'A trade workspace for Thailand travel agencies.',
    lead: 'Search contracted inventory, compare boards and cancellation terms, and confirm against your agency credit — built for speed and control.',
    points: [
      { title: 'Transparent pricing', text: 'Stay totals shown clearly, with charges paid at the hotel listed separately from the sell price.' },
      { title: 'Compare before you commit', text: 'Rooms, boards and cancellation terms side by side, with the full stay total.' },
      { title: 'Credit under control', text: 'Credit limit, balance and payment status in one view.' },
    ],
    heroImage: { src: '/access-resort.jpg', alt: 'Aerial view of a coastal resort with pool terraces beside the sea at sunset.' },
  },
  'india-corporate': {
    slug: 'india-corporate',
    path: '/b2b-hotel-supplier/india-corporate',
    region: 'India (corporate travel)',
    metaTitle: 'Corporate Travel Hotel Supplier for India | fabBeds',
    metaDescription: 'fabBeds gives India-based corporate travel agencies a wholesale hotel distribution workspace: contracted inventory, transparent pricing, and a recheck step before every booking is held.',
    kicker: 'India corporate travel',
    headline: 'Wholesale hotel supply for India’s corporate travel agencies.',
    lead: 'A single workspace to search, compare and confirm contracted hotel stock for corporate travellers, with credit and pricing kept transparent throughout.',
    points: [
      { title: 'Built for repeat bookings', text: 'Safe retries and duplicate-booking checks so a busy desk never double-books a travelling guest.' },
      { title: 'Recheck before you hold', text: 'Price or availability changed? You see it before anything is held.' },
      { title: 'Credit you can see', text: 'Credit limit, balance and payment status in one view, with bank-transfer top-ups declared in the portal.' },
    ],
    heroImage: { src: '/dubai-marina-entrance.jpg', alt: 'Dubai marina waterfront in late afternoon light, with towers reflected in calm water.' },
  },
}

export const MARKET_SLUGS = Object.keys(MARKET_REGISTRY) as MarketSlug[]

export function isMarketSlug(value: string): value is MarketSlug {
  return Object.prototype.hasOwnProperty.call(MARKET_REGISTRY, value)
}
