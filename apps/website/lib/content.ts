import { Building2, Cable, Handshake, Layers, Search, SlidersHorizontal, Users } from 'lucide-react'

// Copy rule for this file: describe capabilities as direction ("designed to", "aims to") unless the
// capability is implemented, tested and enabled. Do not add scale figures, coverage or connectivity claims
// until they are independently verified.

export const messaging = {
  tagline: 'The World’s Wholesale Marketplace.',
  positioning: 'The Next Generation of Global B2B Hotel Distribution.',
  promise: 'More Connections. Smarter Distribution. Greater Opportunity.',
}

export const marketplaceSides = [
  { icon: Building2, title: 'For suppliers', text: 'A framework for presenting hotel content, managing contracted commercial terms, and reaching participating travel buyers.' },
  { icon: Search, title: 'For buyers', text: 'A platform to discover accommodation, compare available rates, and source stays according to their customers’ requirements.' },
]

export const solutionCards = [
  { icon: Building2, title: 'Hotels & Suppliers', tagline: 'Put your property in the distribution mix.', href: '/hotels-suppliers', cta: 'Explore Supplier Solutions', text: 'Bring your hotel inventory, room categories, contracted rates, and commercial partnerships into a structured B2B distribution environment.', audience: 'For hotel groups, independent hotels, resorts, apartments and accommodation suppliers.' },
  { icon: Users, title: 'Travel Buyers', tagline: 'Source stays with greater clarity.', href: '/travel-buyers', cta: 'Explore Buyer Solutions', text: 'Find accommodation for your customers through a B2B sourcing experience designed around destination, dates, occupancy, room options, and rates.', audience: 'For travel agencies, tour operators, DMCs, wholesalers, bedbanks and online travel businesses.' },
]

export const whyFabbeds = [
  { icon: Handshake, title: 'Connected supply and demand', text: 'Bring accommodation suppliers and professional travel buyers into a shared distribution ecosystem, helping both sides discover relevant business opportunities.' },
  { icon: Search, title: 'Smarter hotel sourcing', text: 'Organise accommodation discovery around destination, travel dates, occupancy, room types, board basis, and available commercial rates.' },
  { icon: SlidersHorizontal, title: 'Structured commercial management', text: 'Support a clear framework for supplier contracts, rate plans, availability, pricing rules, and applicable commercial terms.' },
  { icon: Cable, title: 'A pathway to connected distribution', text: 'Build toward digital connectivity that can support online sourcing and, where implemented and approved, integrations with external suppliers and travel technology platforms.' },
  { icon: Layers, title: 'Partnership-led growth', text: 'Combine technology with commercial relationships, responsive support, and a practical understanding of the travel trade.' },
]

export const operatingPrinciples = [
  { title: 'Accurate hotel information', text: 'Property descriptions, room configurations, occupancy details, and board-basis information should be maintained in a structured and reviewable format.' },
  { title: 'Clear commercial conditions', text: 'Rates should be accompanied by relevant validity periods, cancellation rules, restrictions, currency information, and applicable taxes or fees where known.' },
  { title: 'Controlled account access', text: 'Marketplace access should reflect the user’s role, organisation, and approved permissions.' },
  { title: 'Appropriate validation', text: 'Prices and availability should be checked through the applicable supplier or platform workflow before a booking is treated as confirmed.' },
  { title: 'Responsible distribution', text: 'Supplier content, commercial terms, and customer information should be handled according to applicable agreements and privacy requirements.' },
]

export const partnerRoutes = [
  { title: 'For Hotels & Suppliers', text: 'Bring your property portfolio and commercial offering into the conversation.', cta: 'Become a Supplier Partner' },
  { title: 'For Travel Buyers', text: 'Tell us about your travel business and the accommodation supply you need.', cta: 'Register Your Business' },
  { title: 'For Distribution & Technology Partners', text: 'Explore potential commercial relationships and connectivity opportunities.', cta: 'Discuss a Partnership' },
]

export type PageAction = { label: string; href: string; secondary?: boolean }
export type ContentBlock = { heading: string; text?: string; style: 'steps' | 'cards'; items: { title: string; text: string }[] }
export type MarketingPageContent = {
  eyebrow: string; title: string; intro: string; proof: string
  sections: { title: string; text: string; items?: string[] }[]
  blocks?: ContentBlock[]
  note?: string
  faq?: { question: string; answer: string }[]
  actions?: PageAction[]
}

export const marketingPages: Record<'hotelsSuppliers' | 'travelBuyers' | 'howItWorks' | 'connectivity' | 'about' | 'contact', MarketingPageContent> = {
  hotelsSuppliers: {
    eyebrow: 'Hotels & Suppliers', title: 'Your Property. More Possibilities.',
    intro: 'Every hotel has its own strengths, customer segments, contracted rates, and distribution opportunities. fabbeds aims to help accommodation providers organise their commercial offering and connect with professional travel buyers through a structured wholesale marketplace.',
    proof: 'Structured content · Contracted rates · Approved buyer access',
    actions: [{ label: 'List Your Property', href: '/request-demo' }, { label: 'Become a Supplier Partner', href: '/request-demo', secondary: true }],
    sections: [
      { title: 'Who it is for', text: 'Whether you represent an independent hotel, a regional chain, a resort, serviced apartments, or a hotel portfolio, fabbeds provides a framework for building B2B distribution relationships.', items: ['Independent hotels', 'Hotel groups and regional chains', 'Resorts and serviced apartments', 'Accommodation suppliers'] },
      { title: 'What you bring', text: 'The property and commercial detail buyers need to evaluate your offer.', items: ['Property content and room categories', 'Contracted rates and availability', 'Cancellation and occupancy conditions'] },
      { title: 'What you work toward', text: 'A structured route to professional buyers, subject to approval.', items: ['Approved buyer access', 'Consistent commercial terms', 'Distribution through supported channels'] },
    ],
    blocks: [
      { heading: 'Why partner with fabbeds?', style: 'cards', items: [
        { title: 'Broader buyer opportunities', text: 'Work toward access to travel agencies, tour operators, DMCs, wholesalers, and other approved buyer segments.' },
        { title: 'Structured hotel information', text: 'Organise property details, room categories, amenities, board basis, and destination information.' },
        { title: 'Commercial rate management', text: 'Establish a structured approach to contracted rates, rate plans, availability, and applicable booking conditions.' },
        { title: 'Distribution flexibility', text: 'Build a foundation for different commercial agreements and connectivity approaches as supported by the platform.' },
        { title: 'Partner relationships', text: 'Develop distribution through direct commercial engagement and an evolving B2B ecosystem.' },
        { title: 'Operational clarity', text: 'Aim for more consistent management of hotel content, pricing information, and supplier workflows.' },
      ] },
      { heading: 'How supplier onboarding works', style: 'steps', items: [
        { title: 'Register your business', text: 'Submit your company details, business registration information, commercial contact, and supplier profile for review.' },
        { title: 'Share your hotel portfolio', text: 'Provide property details, room categories, facilities, photographs, location information, and relevant hotel identifiers.' },
        { title: 'Establish commercial terms', text: 'Agree on contracted rates, applicable dates, currency, occupancy rules, cancellation conditions, meal plans, and other relevant restrictions.' },
        { title: 'Configure and validate your supply', text: 'Verify hotel content, rate structures, availability arrangements, and pricing rules before making the relevant supply available to eligible buyers.' },
        { title: 'Develop distribution opportunities', text: 'Once approved and operationally enabled, make eligible hotel content available through the distribution channels supported by your agreement and the platform.' },
      ] },
    ],
    note: 'Commercial availability, buyer access, and distribution methods depend on approval, contracted terms, and enabled platform capabilities.',
  },
  travelBuyers: {
    eyebrow: 'Travel Buyers', title: 'More Hotel Choice. A Smarter Way to Source.',
    intro: 'Your customers need the right stay. Your business needs the right supply. fabbeds is designed to give professional travel businesses a structured environment for sourcing accommodation, reviewing available options, and working with participating suppliers through a B2B marketplace.',
    proof: 'Destination-led sourcing · Clear rate conditions · Revalidation before booking',
    actions: [{ label: 'Register as a Travel Buyer', href: '/request-demo' }, { label: 'Request Business Access', href: '/request-demo', secondary: true }],
    sections: [
      { title: 'Search by what matters', text: 'Organise sourcing around the details every itinerary starts with.', items: ['Destination', 'Check-in and check-out dates', 'Room count and guest occupancy'] },
      { title: 'Compare the details', text: 'Examine the terms that decide whether a rate fits the customer.', items: ['Applicable price and currency', 'Room configuration and meal plan', 'Cancellation terms and availability conditions'] },
      { title: 'Commercial confidence', text: 'fabbeds should present applicable rates, currencies, occupancy restrictions, cancellation policies, and supplier conditions clearly, with the appropriate revalidation before booking.' },
    ],
    blocks: [
      { heading: 'Designed for the travel trade', style: 'cards', items: [
        { title: 'Travel agencies', text: 'Source accommodation for FIT travellers, families, couples, groups, and tailor-made holidays.' },
        { title: 'Tour operators', text: 'Build hotel options into itineraries, destination packages, and seasonal travel programmes.' },
        { title: 'DMCs & destination specialists', text: 'Source accommodation aligned with destination expertise, group requirements, and contracted travel arrangements.' },
        { title: 'Wholesalers, bedbanks & travel platforms', text: 'Explore structured hotel sourcing and potential connectivity pathways aligned with commercial agreements.' },
      ] },
      { heading: 'A straightforward hotel sourcing journey', style: 'steps', items: [
        { title: 'Search your destination', text: 'Enter the destination, check-in and check-out dates, room count, and guest occupancy.' },
        { title: 'Discover hotel options', text: 'Review eligible properties and the room or rate options returned for your search.' },
        { title: 'Compare the details', text: 'Examine the applicable price, room configuration, meal plan, occupancy, cancellation terms, and availability conditions.' },
        { title: 'Review your selection', text: 'Confirm the displayed terms and revalidate price and availability through the supported booking workflow.' },
        { title: 'Proceed according to your access', text: 'Complete the actions available to your approved account and enabled services. A booking is confirmed only when the platform or supplier explicitly confirms it.' },
      ] },
    ],
    note: 'Real-time availability, immediate confirmation, credit facilities, payment services, and external connectivity are offered only to buyer accounts and suppliers for which those capabilities have been implemented and enabled.',
  },
  howItWorks: {
    eyebrow: 'How it works', title: 'One connected distribution model.',
    intro: 'fabbeds is designed around the relationship between hotel inventory, supplier agreements, distribution rules, and travel buyer demand.',
    proof: 'Supply · Contracts · Rates · Pricing · Distribution',
    sections: [
      { title: 'Hotels & accommodation suppliers', text: 'The source of supply.', items: ['Property content', 'Room types', 'Contracted rates', 'Availability'] },
      { title: 'The fabbeds distribution platform', text: 'Where supply, rules and buyer access meet.', items: ['Hotel master', 'Contract management', 'Rate rules', 'Search', 'Buyer access'] },
      { title: 'Travel buyers & distribution partners', text: 'The demand side.', items: ['Agencies', 'Tour operators', 'DMCs', 'Wholesalers', 'Travel platforms'] },
    ],
    blocks: [
      { heading: 'From contracted supply to buyer-ready rates', text: 'A successful wholesale marketplace needs more than a list of hotels. It needs consistent property data, clear commercial agreements, reliable rate calculations, and transparent conditions. The intended distribution workflow is built around five foundations.', style: 'steps', items: [
        { title: 'Supply', text: 'Standardised hotel, room, and board-basis information.' },
        { title: 'Contracts', text: 'Supplier agreements, validity periods, and applicable commercial restrictions.' },
        { title: 'Rates and availability', text: 'Daily rates, inventory rules, and eligibility for the requested stay.' },
        { title: 'Pricing', text: 'Application of authorised markup and commercial pricing rules to the relevant supplier rate.' },
        { title: 'Distribution', text: 'Presentation of eligible results to approved buyers, followed by the appropriate validation and booking process.' },
      ] },
    ],
    note: 'Conceptual operating model — not a representation of every live integration or enabled feature.',
    faq: [
      { question: 'What is fabbeds?', answer: 'fabbeds is a B2B hotel distribution marketplace being developed to connect accommodation suppliers with professional travel buyers through structured hotel sourcing and commercial workflows.' },
      { question: 'Who can join fabbeds?', answer: 'Eligible businesses may include hotels, hotel groups, accommodation suppliers, travel agencies, tour operators, DMCs, wholesalers, bedbanks, and travel technology businesses. Access is subject to the applicable registration and approval process.' },
      { question: 'How does fabbeds help hotels?', answer: 'The platform is designed to support structured hotel information, contracted rate management, and distribution opportunities with participating travel buyers.' },
      { question: 'How does fabbeds help travel agencies?', answer: 'It aims to provide a structured way to search for accommodation, review eligible rates and room options, and evaluate applicable commercial conditions.' },
      { question: 'Does fabbeds offer wholesale hotel rates?', answer: 'The platform is designed for B2B hotel distribution, including contracted commercial rates where applicable. Rates and availability depend on supplier agreements, property, travel dates, and account eligibility.' },
      { question: 'Can I connect my system to fabbeds through an API or XML?', answer: 'Connectivity options depend on the integrations that have been implemented, tested, and enabled. Businesses can submit an integration inquiry to discuss their requirements.' },
      { question: 'Is a booking confirmed as soon as I see a rate?', answer: 'No. A booking should be treated as confirmed only when the relevant enabled booking workflow or supplier returns an explicit confirmation. Search results alone do not guarantee a booking.' },
      { question: 'Can suppliers manage their own hotels and rates?', answer: 'Supplier-side access and management functions depend on the permissions and features enabled for the relevant supplier account.' },
      { question: 'How do I get started?', answer: 'Choose the relevant supplier or travel buyer registration route, submit your business details, and complete any verification and commercial onboarding steps required.' },
    ],
  },
  connectivity: {
    eyebrow: 'Technology & Connectivity', title: 'Technology That Connects Travel.',
    intro: 'The future of hotel distribution depends on the ability to organise complex supply, commercial data, and buyer demand in a way that works across different business models. fabbeds is being developed with a technology-led approach, with an emphasis on structured data, controlled access, pricing consistency, and a pathway toward scalable connectivity.',
    proof: 'Structured data · Controlled access · Connectivity readiness',
    actions: [{ label: 'Discuss a Partnership', href: '/request-demo' }],
    sections: [
      { title: 'Online sourcing', text: 'For businesses that prefer a sourcing interface.', items: ['Search and rate evaluation', 'Account-based access'] },
      { title: 'System-to-system integration', text: 'For businesses that need to connect their own systems.', items: ['API and XML adapters (coming soon)', 'Controlled partner access'] },
      { title: 'Managed commercial relationship', text: 'For businesses that prefer to work with a team.', items: ['Direct commercial engagement', 'Agreement-led onboarding'] },
    ],
    blocks: [
      { heading: 'Our technology direction', style: 'cards', items: [
        { title: 'Centralised hotel and room data', text: 'A consistent foundation for accommodation content.' },
        { title: 'Contract and rate management', text: 'Structured supplier agreements and applicable pricing rules.' },
        { title: 'Search and rate evaluation', text: 'Matching travel requirements against eligible hotel and rate information.' },
        { title: 'Controlled partner access', text: 'Account permissions and business-specific access to relevant marketplace functions.' },
        { title: 'Connectivity readiness', text: 'An architecture designed to evolve toward external supplier and distribution integrations.' },
        { title: 'Operational visibility', text: 'Workflows to help authorised teams review platform activity, supply status, and operational exceptions.' },
      ] },
    ],
    note: 'API, XML, channel manager, GDS, and third-party connectivity are described as available only where an actual integration is completed, tested, and approved. None is generally available yet.',
  },
  about: {
    eyebrow: 'About fabbeds', title: 'Reimagining the way the travel trade sources and distributes hotels.',
    intro: 'fabbeds is building a B2B hotel distribution marketplace designed to bring accommodation suppliers and professional travel businesses closer together. We believe hotel distribution can be more structured, more connected, and easier to navigate.',
    proof: 'B2B-first · Partnership-led · Designed to evolve',
    actions: [{ label: 'Partner with fabbeds', href: '/request-demo' }],
    sections: [
      { title: 'Our vision', text: 'To build a trusted, technology-led B2B hotel distribution marketplace that makes accommodation sourcing and wholesale distribution more accessible to travel businesses.' },
      { title: 'Our mission', text: 'To connect accommodation supply and travel demand through structured commercial data, efficient sourcing workflows, and a partnership-led distribution ecosystem.' },
      { title: 'Who we are building for', text: 'From independent hotels and regional accommodation suppliers to agencies, tour operators, and destination specialists, fabbeds is being built around the different businesses that make global travel possible.' },
    ],
    blocks: [
      { heading: 'Our values', style: 'cards', items: [
        { title: 'Trust', text: 'Transparent terms, responsible business practices, and accountable partnerships.' },
        { title: 'Clarity', text: 'Structured information and understandable commercial conditions.' },
        { title: 'Innovation', text: 'Practical technology that addresses real distribution challenges.' },
        { title: 'Collaboration', text: 'Long-term relationships across the travel value chain.' },
        { title: 'Growth', text: 'Expanding opportunities through better-connected supply and demand.' },
      ] },
      { heading: 'Better information. Clearer decisions.', text: 'In B2B hotel distribution, the quality of the transaction depends on the quality of the underlying information. These are the operating principles fabbeds is being built around.', style: 'cards', items: operatingPrinciples },
    ],
  },
  contact: {
    eyebrow: 'Contact Us', title: 'Let’s Build Better Connections in Travel.',
    intro: 'Whether you supply accommodation or source hotels for your customers, the right distribution relationships can open new commercial opportunities. Join the fabbeds partner ecosystem and explore how a connected B2B marketplace can support the next stage of your business.',
    proof: 'Suppliers · Travel buyers · Technology partners',
    actions: [{ label: 'Discuss a Partnership', href: '/request-demo' }],
    sections: [
      { title: 'For Hotels & Suppliers', text: 'Bring your property portfolio and commercial offering into the conversation.', items: ['Direct hotels', 'Hotel groups and DMC portfolios'] },
      { title: 'For Travel Buyers', text: 'Tell us about your travel business and the accommodation supply you need.', items: ['Travel agencies', 'Tour operators and wholesalers'] },
      { title: 'For Distribution & Technology Partners', text: 'Explore potential commercial relationships and connectivity opportunities.', items: ['Bedbanks and travel platforms', 'Integration enquiries'] },
    ],
  },
}
