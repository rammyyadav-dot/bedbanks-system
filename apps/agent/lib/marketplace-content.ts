export const contactEmail = 'hello@fbeds.com'

export const heroCopy = {
  headline: 'Your gateway to smarter hotel distribution.',
  supporting: 'Discover hotel opportunities, compare room and board options, and recheck availability through one trade-focused workspace.',
  primaryCta: 'Agent Sign In',
  secondaryCta: 'Request Agent Access',
  joinLabel: 'Join us',
  partnerInvitation: 'Travel agencies can request access. The FabBeds team reviews each request. Sending a message does not create an account or a workspace role.',
} as const

export const privacyLink = {
  href: 'https://www.fbeds.com/privacy',
  label: 'Privacy (public draft)',
  note: 'The public privacy page is a draft pending legal review. It is not an approved policy.',
} as const

export type EditorialPage = {
  path: '/about' | '/support' | '/contact' | '/news' | '/access'
  kicker: string
  title: string
  summary: string
  sections: Array<{ title: string; paragraphs: string[] }>
}

export const editorialPages = {
  about: {
    path: '/about',
    kicker: 'About fBeds',
    title: 'A trade workspace for hotel distribution.',
    summary: 'fBeds is an enterprise bedbank program focused on reducing fragmentation across hospitality supply, B2B demand, and booking technology.',
    sections: [
      {
        title: 'What this workspace does',
        paragraphs: [
          'Signed-in agents can search a destination, compare room and board options, and recheck a selected offer against current contracted inventory.',
          'A search price is a quote from that search. It is not confirmed availability until an authoritative recheck succeeds.',
        ],
      },
      {
        title: 'How the program is built',
        paragraphs: [
          'Capability is added in controlled phases. Prototypes are not presented as production booking systems.',
          'Booking, confirmation, and payment stay off in this workspace until those operations are explicitly enabled.',
        ],
      },
    ],
  },
  support: {
    path: '/support',
    kicker: 'Agent Support',
    title: 'Help with search and workspace access.',
    summary: 'Use the verified fBeds contact email. Support messages do not include session tokens or account credentials.',
    sections: [
      {
        title: 'Before you write',
        paragraphs: [
          'If a search fails, return to the workspace and try the same destination, dates, and occupancy again. The previous result is not reused as confirmed availability.',
          'Include your agency name, the destination, and the stay dates. Do not paste passwords, session cookies, or supplier credentials.',
        ],
      },
      {
        title: 'Contact',
        paragraphs: [`Email ${contactEmail}. Online ticket submission is not configured in this portal.`],
      },
    ],
  },
  contact: {
    path: '/contact',
    kicker: 'Contact Our Team',
    title: 'Talk with the fBeds team.',
    summary: 'Tell us whether you source hotels, sell B2B travel, or operate an agency workspace.',
    sections: [
      {
        title: 'Verified channel',
        paragraphs: [
          `The contact address published for fBeds is ${contactEmail}.`,
          'No office address or telephone number is published in this portal.',
        ],
      },
    ],
  },
  news: {
    path: '/news',
    kicker: 'Trade News & Updates',
    title: 'Updates for the agent workspace.',
    summary: 'These notes describe the current workspace. They are editorial. They are not live rates or supplier announcements.',
    sections: [
      {
        title: 'Dubai search pilot',
        paragraphs: [
          'Authenticated agents can search Dubai, open a hotel, compare room and board options, and run an authoritative recheck.',
          'Booking remains disabled.',
        ],
      },
      {
        title: 'Recheck before you rely on a price',
        paragraphs: [
          'The stay total shown on a search result can change or expire. Accept a changed total only when the recheck says the price changed, then recheck again.',
        ],
      },
    ],
  },
  access: {
    path: '/access',
    kicker: 'Request Agent Access',
    title: 'Ask the fBeds team to review agency access.',
    summary: 'Online lead submission is not configured. This page does not create an account or grant a role.',
    sections: [
      {
        title: 'What to include',
        paragraphs: [
          'Email your agency name, a work contact name, a work email address, and the market you sell.',
          'Access is granted only after the fBeds team reviews the request outside this form.',
        ],
      },
    ],
  },
} as const satisfies Record<string, EditorialPage>

export const entranceCards = [
  { href: editorialPages.about.path, title: editorialPages.about.kicker, text: 'How the agent workspace searches, compares, and rechecks hotel offers.' },
  { href: editorialPages.support.path, title: editorialPages.support.kicker, text: 'Verified email support and a path back to hotel search.' },
  { href: editorialPages.contact.path, title: editorialPages.contact.kicker, text: `Write to ${contactEmail}. No other contact channel is published here.` },
  { href: editorialPages.news.path, title: editorialPages.news.kicker, text: 'Editorial notes on the Dubai pilot and authoritative recheck.' },
] as const

export const dubaiSpotlight = {
  destination: 'Dubai',
  title: 'Dubai pilot',
  text: 'Dubai is the current searchable destination in this workspace. Set dates and occupancy, then run a fresh search. Stay prices appear only on the search result.',
  action: 'Explore Dubai',
} as const

export const editorialDestinations = [
  { name: 'London', note: 'Editorial. Not a searchable destination in this workspace.' },
  { name: 'Paris', note: 'Editorial. Not a searchable destination in this workspace.' },
  { name: 'Singapore', note: 'Editorial. Not a searchable destination in this workspace.' },
] as const

export const howItWorks = [
  { title: 'Search', text: 'Enter a city or destination, stay dates, rooms, and occupancy. Choose an age for each child before you search. Hotel name, area, landmark, and airport are not search fields.' },
  { title: 'Compare', text: 'Open a hotel to see the room, board basis, and the authoritative total stay price returned for that search.' },
  { title: 'Recheck', text: 'Select an offer and recheck it. A cached search price is not confirmed availability. Booking stays disabled.' },
] as const

export const tradeAnnouncements = [
  { title: 'Search, then recheck', text: 'Use the Dubai pilot to compare room and board options. Treat the search total as a quote until recheck completes.' },
  { title: 'Access is reviewed', text: 'Request agent access by email. The portal does not approve agencies by itself.' },
] as const

export const marketplaceHome = {
  title: 'Search hotel inventory',
  supporting: 'Find available hotel rates, compare room and board options, and recheck the selected offer before proceeding.',
  resultsQuote: 'Search quotes — price and availability require recheck before proceeding.',
  destinationPlaceholder: 'City or destination',
  searchCta: 'Search Hotels',
  searchingCta: 'Searching…',
  retryCta: 'Retry Search',
  currencyLabel: 'Display currency',
  currencyCode: 'AED',
  currencyNote: 'The server prices this search in AED.',
  nationalityLabel: 'Guest nationality',
  nationalityHelper: 'Sent with the search. Contracted rates in this workspace are not selected by guest nationality.',
  advancedLabel: 'Advanced Search',
  advancedNote: 'Star rating, refundable rates, and a whole-dirham total-stay price are sent to search. The price range is the stay total, not a nightly rate. Hotel name, meal plan, and preferred hotels are not filters.',
  recentTitle: 'Recent searches',
  recentEmpty: 'Searches you complete in this browser stay on this device for this account until you sign out. A previous price is not stored or shown.',
  offerStrip: 'Dubai partner search. Run a fresh search for the dates and occupancy above.',
  residencyNote: 'A separate guest-residency field is not used. Nationality is the market value sent with search.',
} as const
