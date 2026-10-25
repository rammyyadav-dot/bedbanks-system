export const contactEmail = 'hello@fbeds.com'

/** Brand line used in the logo lockup and page metadata. Claims here must stay true of the product today. */
export const brandTagline = 'Wholesale hotels. Trade-ready.'

export const heroCopy = {
  eyebrow: 'Travel trade platform',
  headline: 'Book wholesale hotels with total clarity.',
  supporting: 'Search contracted Dubai inventory, compare rooms and boards, recheck availability and price, then confirm against your agency credit. One workspace built for speed and control.',
  primaryCta: 'Agent Sign In',
  secondaryCta: 'Request Agent Access',
  joinLabel: 'Join us',
  partnerInvitation: 'Travel agencies can request access. The fabBeds team reviews each request. Sending a message does not create an account or a workspace role.',
} as const

/** Public home page. Describes capability, never volume, price advantage or availability. */
export const homeCopy = {
  stepsTitle: 'Search to confirmed in four steps',
  steps: [
    { title: 'Search', text: 'Choose a destination, dates, rooms and guests. Filter by star, board and price.' },
    { title: 'Compare', text: 'Rooms, boards and cancellation terms side by side, with the stay total in AED.' },
    { title: 'Recheck', text: 'Re-price the selected rate against current inventory before anything is held.' },
    { title: 'Book', text: 'Hold, add guest names and confirm. Voucher and invoice follow on confirmation.' },
  ],
  stepsNote: 'A search price is a quote until a recheck succeeds. Booking is available to agencies where it has been enabled.',
  techTitle: 'Travel technology that keeps every booking defensible',
  tech: [
    { title: 'Recheck before hold', text: 'Price or availability changed? You see it before any inventory is held, and nothing is swapped silently.' },
    { title: 'Transparent pricing', text: 'Stay totals in AED. Charges paid at the hotel are listed separately. Add your own client mark-up for display.' },
    { title: 'Credit under control', text: 'Credit limit, balance and payment status in one view, with bank-transfer top-ups declared in the portal.' },
    { title: 'Built for reliability', text: 'Duplicate-booking checks, safe retries and an audit trail on every booking action.' },
  ],
  bandTitle: 'Ready to trade with fabBeds?',
  bandText: 'Request agency access. The fabBeds team reviews every request.',
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
    kicker: 'About fabBeds',
    title: 'A trade workspace for hotel distribution.',
    summary: 'fabBeds is an enterprise bedbank program focused on reducing fragmentation across hospitality supply, B2B demand, and booking technology.',
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
    summary: 'Use the verified fabBeds contact email. Support messages do not include session tokens or account credentials.',
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
    title: 'Talk with the fabBeds team.',
    summary: 'Tell us whether you source hotels, sell B2B travel, or operate an agency workspace.',
    sections: [
      {
        title: 'Verified channel',
        paragraphs: [
          `The contact address published for fabBeds is ${contactEmail}.`,
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
    title: 'New to fabBeds? Tell us about your agency.',
    summary: 'Complete the agency details below and send them to the fabBeds team. This page does not create an account or grant a role.',
    sections: [],
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
  { title: 'Search', text: 'Select a canonical city or hotel, stay dates, rooms, and occupancy. Choose an age for each child before you search. Area, landmark, and airport are not search fields.' },
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
  searchCta: 'Search',
  searchingCta: 'Searching…',
  retryCta: 'Retry Search',
  currencyLabel: 'Selling currency',
  currencyCode: 'AED',
  currencyNote: 'The server prices this search in the selling currency you select.',
  nationalityLabel: 'Guest nationality',
  nationalityHelper: 'Guest nationality is preserved for search and authoritative recheck eligibility.',
  advancedLabel: 'Advanced Search',
  advancedNote: 'Star rating, refundable rates, board, property type, and a total-stay price are sent to search. The price range uses the selected currency and is the stay total, not a nightly rate. Landmark and airport are not filters.',
  recentTitle: 'Recent searches',
  recentEmpty: 'Searches you complete in this browser stay on this device for this account until you sign out. A previous price is not stored or shown.',
  offerStrip: 'Dubai partner search. Run a fresh search for the dates and occupancy above.',
  residencyNote: 'A separate guest-residency field is not used. Nationality is the market value sent with search.',
} as const

/** Request Agent Access page. Process steps describe review, never turnaround time, volume or approval odds. */
export const accessCopy = {
  steps: [
    { title: 'Tell us about your agency', text: 'Complete the agency, contact and trading details. Fields marked * are required.' },
    { title: 'Send the request', text: `Your email app opens with the details filled in. Send it to ${contactEmail}. This page does not transmit the form for you.` },
    { title: 'The fabBeds team reviews it', text: 'Each agency is reviewed by a person. Review happens outside this page, and we may ask for supporting documents.' },
    { title: 'Access is set up', text: 'If approved, the team creates your agency and sign-in. Nothing is active until then.' },
  ],
  reviewTitle: 'What the team looks at',
  review: [
    { title: 'Who you are', text: 'Registered company name and country, website and a work email on your agency domain.' },
    { title: 'How you sell', text: 'Business type, markets and the connection you plan to use: booking website, API or both.' },
    { title: 'Fit for the workspace', text: 'Today the workspace offers a Dubai search pilot with authoritative recheck. Booking is enabled per agency.' },
  ],
  prepareTitle: 'Have these ready',
  prepare: ['Registered company name and number', 'Trade licence or travel-agency accreditation, if your country issues one', 'Company website and a work email address', 'The markets you sell and your estimated monthly room nights'],
  supplierTitle: 'Are you a hotel or supplier?',
  supplierText: `This form is for travel agencies. Hotels and suppliers should write to ${contactEmail} and say they are a supplier.`,
  privacyNote: 'The details you enter stay in your browser until you send the email yourself. fabBeds stores nothing from this page.',
  successTitle: 'Your email app should now be open',
  successText: `Send the message to ${contactEmail} to complete your request. If nothing opened, copy the text below and email it yourself. Your request is not received until you send it.`,
} as const
