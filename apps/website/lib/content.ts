import { BarChart3, BedDouble, Building2, Cable, FileCheck2, Globe2, Hotel, KeyRound, Network, Search, ShieldCheck, SlidersHorizontal, UsersRound, Zap } from 'lucide-react'

export const capabilities = [
  { icon: Hotel, title: 'Hotel content', text: 'Structure hotel, room and policy information for consistent downstream use.' },
  { icon: SlidersHorizontal, title: 'Commercial controls', text: 'Keep contracts, rates, restrictions and availability close to the teams operating them.' },
  { icon: Cable, title: 'Connectivity boundaries', text: 'Prepare API and XML connections behind explicit contracts, monitoring and fallback policies.' },
  { icon: ShieldCheck, title: 'Booking control', text: 'Design booking, cancellation and audit workflows around traceability and clear state.' },
]

export const audiences = [
  { title: 'Travel agencies', href: '/solutions/travel-agencies', text: 'A clearer route from search criteria to bookable hotel options.', icon: Search },
  { title: 'Tour operators', href: '/solutions/tour-operators', text: 'Contracted inventory and operating controls for packaged travel.', icon: Globe2 },
  { title: 'DMCs', href: '/solutions/dmcs', text: 'A supplier workspace for local contracting and distribution readiness.', icon: Network },
  { title: 'Hotels', href: '/solutions/hotels', text: 'Structured content, inventory and commercial setup in one workflow.', icon: Building2 },
  { title: 'Travel technology', href: '/solutions/travel-technology', text: 'Defined integration boundaries for product and engineering teams.', icon: Zap },
]

export const workflow = [
  { number: '01', title: 'Structure supply', text: 'Bring hotel content, rooms, contracts and restrictions into governed workflows.' },
  { number: '02', title: 'Control availability', text: 'Manage the commercial and inventory signals that determine what can be sold.' },
  { number: '03', title: 'Connect demand', text: 'Expose approved inventory through clear buyer and technology boundaries.' },
  { number: '04', title: 'Operate bookings', text: 'Track booking state, documents, cancellations and settlement readiness.' },
]

export type MarketingPageContent = {
  eyebrow: string; title: string; intro: string; proof: string
  sections: { title: string; text: string; items: string[] }[]
}

export const marketingPages: Record<'platform' | 'inventory' | 'connectivity' | 'about' | 'resources' | 'contact', MarketingPageContent> = {
  platform: {
    eyebrow: 'Platform', title: 'A control layer between hotel supply and B2B demand.',
    intro: 'fBeds is being built around the operational handoffs that make hotel distribution work: content, commercial setup, availability, bookings and oversight.',
    proof: 'Modular by design · API boundary preserved · Human review where it matters',
    sections: [
      { title: 'Supply operations', text: 'Give hotels and supply partners a structured path from onboarding to distribution readiness.', items: ['Hotel and room content', 'Contracts and rate plans', 'Availability and restrictions'] },
      { title: 'Demand workflows', text: 'Support buyer journeys without hiding pricing, inventory or booking state behind unclear fallbacks.', items: ['Search and rate recheck', 'Prebook and booking states', 'Voucher and cancellation workflows'] },
      { title: 'Platform oversight', text: 'Keep operational teams close to tenancy, permissions, audit events and finance boundaries.', items: ['Tenant-aware access', 'Explicit permissions', 'Audit and settlement readiness'] },
    ],
  },
  inventory: {
    eyebrow: 'Inventory', title: 'Organise hotel supply before asking it to scale.',
    intro: 'A reliable distribution layer starts with mapped content, explicit commercial rules and availability that can be explained night by night.',
    proof: 'Contracted and dynamic supply · Buyer-ready content · No silent rate fallback',
    sections: [
      { title: 'Contracted supply', text: 'Represent negotiated hotel agreements without separating the rate from its operating conditions.', items: ['Contract periods', 'Room and meal-plan mapping', 'Cancellation and restriction rules'] },
      { title: 'Dynamic supply', text: 'Prepare external supplier content for mapping, validation and controlled distribution.', items: ['Supplier identity', 'Hotel and room mapping', 'Connection health'] },
      { title: 'Distribution readiness', text: 'Make gaps visible before inventory is exposed to buyers.', items: ['Content completeness', 'Availability coverage', 'Stop-sale and restriction review'] },
    ],
  },
  connectivity: {
    eyebrow: 'Connectivity', title: 'Integration boundaries teams can understand and operate.',
    intro: 'fBeds separates connector behavior from core commercial logic so API and XML integrations can evolve without obscuring booking decisions.',
    proof: 'Typed contracts · Connector isolation · Observable failure states',
    sections: [
      { title: 'Supplier connections', text: 'Prepare third-party supply behind explicit mappings and operational controls.', items: ['API and XML adapters', 'Credential isolation', 'Timeout and retry policies'] },
      { title: 'Buyer distribution', text: 'Design outbound access around stable contracts and traceable transactions.', items: ['Search and availability contracts', 'Booking lifecycle events', 'Idempotency expectations'] },
      { title: 'Operational resilience', text: 'Treat degraded connections as visible states, not silent substitutions.', items: ['Health monitoring', 'Actionable errors', 'Audited fallback decisions'] },
    ],
  },
  about: {
    eyebrow: 'Company', title: 'Building the connected layer behind better hotel distribution.',
    intro: 'fBeds is an enterprise bedbank program focused on reducing fragmentation across hospitality supply, B2B demand and booking technology.',
    proof: 'B2B-first · Architecture-led · Built around real operating workflows',
    sections: [
      { title: 'Our focus', text: 'Make complex hotel-distribution work easier to understand, govern and improve.', items: ['Clear product boundaries', 'Reliable commercial logic', 'Practical operating tools'] },
      { title: 'Our approach', text: 'Build capability in controlled phases and avoid presenting prototypes as production systems.', items: ['Evidence before claims', 'Reviewable delivery', 'Security and tenancy by design'] },
      { title: 'Who we serve', text: 'Design for the organisations responsible for sourcing, selling and operating hotel inventory.', items: ['Hotels and DMCs', 'Agencies and tour operators', 'OTAs and travel technology'] },
    ],
  },
  resources: {
    eyebrow: 'Resources', title: 'Practical frameworks for modern hotel distribution.',
    intro: 'This resource centre is being prepared for technical notes, operating guides and commercial perspectives. No publication library is connected yet.',
    proof: 'Distribution strategy · Operating controls · Integration readiness',
    sections: [
      { title: 'Distribution foundations', text: 'Understand the decisions that sit between a hotel contract and a bookable offer.', items: ['Content and mapping', 'Occupancy and pricing', 'Availability coverage'] },
      { title: 'Operational readiness', text: 'Use explicit checks before opening new inventory or connections.', items: ['Supplier onboarding', 'Rate validation', 'Booking exception handling'] },
      { title: 'Technical integration', text: 'Define connector responsibilities without coupling them to core pricing or booking rules.', items: ['Contract versioning', 'Idempotency', 'Monitoring and support'] },
    ],
  },
  contact: {
    eyebrow: 'Contact', title: 'Start with your distribution model and operating priorities.',
    intro: 'Tell us whether you source hotels, sell B2B travel or build travel technology. We will use that context to plan a useful first conversation.',
    proof: 'Commercial fit · Integration scope · Operating model',
    sections: [
      { title: 'Hotels and suppliers', text: 'Discuss content, contracting, rates, availability and distribution readiness.', items: ['Direct hotels', 'DMC portfolios', 'Channel and connectivity partners'] },
      { title: 'Travel sellers', text: 'Explore buyer access, hotel search and booking workflow requirements.', items: ['Travel agencies', 'Tour operators', 'B2B marketplaces'] },
      { title: 'Technology teams', text: 'Review API boundaries and the operational responsibilities around an integration.', items: ['Product scope', 'Technical contracts', 'Support and monitoring'] },
    ],
  },
}

export type SolutionKey = 'travel-agencies' | 'tour-operators' | 'dmcs' | 'hotels' | 'travel-technology'
export const solutionPages: Record<SolutionKey, MarketingPageContent & { icon: typeof UsersRound }> = {
  'travel-agencies': { icon: UsersRound, eyebrow: 'Travel agencies', title: 'Hotel sourcing workflows built for B2B selling.', intro: 'Give agency teams a clearer journey from search criteria to reviewed rates and booking state.', proof: 'Search clarity · Rate recheck · Traceable booking state', sections: [
    { title: 'Find relevant supply', text: 'Structure destination, dates, rooms, occupancy, nationality and currency before search.', items: ['Explicit search criteria', 'Mapped hotel content', 'Comparable room options'] },
    { title: 'Protect the booking decision', text: 'Recheck price and availability before confirming a transaction.', items: ['Rate validation', 'Cancellation visibility', 'Clear failure states'] },
    { title: 'Operate after confirmation', text: 'Keep booking references, vouchers and support context together.', items: ['Booking status', 'Voucher workflow', 'Cancellation requests'] },
  ] },
  'tour-operators': { icon: BedDouble, eyebrow: 'Tour operators', title: 'Contracted hotel supply with operating controls attached.', intro: 'Organise negotiated rooms, periods and rules for packaging and B2B distribution.', proof: 'Contracts · Allotments · Restrictions', sections: [
    { title: 'Commercial structure', text: 'Keep contract periods and rate plans aligned to hotel and room mappings.', items: ['Seasons and markets', 'Meal plans', 'Occupancy conditions'] },
    { title: 'Inventory control', text: 'Represent availability and restrictions without losing their source or timing.', items: ['Allotments', 'Stop sales', 'Minimum stay rules'] },
    { title: 'Operational review', text: 'Surface gaps before offers reach sales teams or downstream buyers.', items: ['Coverage checks', 'Content readiness', 'Exception queues'] },
  ] },
  dmcs: { icon: Network, eyebrow: 'Destination management companies', title: 'A supply workspace for local contracting and distribution.', intro: 'Prepare hotel portfolios for consistent onboarding, commercial control and buyer access.', proof: 'Portfolio view · Local contracting · Distribution readiness', sections: [
    { title: 'Portfolio onboarding', text: 'Create a governed record for every contracted property.', items: ['Hotel identity', 'Room definitions', 'Contacts and policies'] },
    { title: 'Commercial operations', text: 'Work with contracts, rates, promotions and restrictions in one operating model.', items: ['Contract tracking', 'Rate plan setup', 'Promotion windows'] },
    { title: 'Distribution oversight', text: 'Understand which hotels are ready, blocked or awaiting review.', items: ['Readiness status', 'Mapping state', 'Coverage reporting'] },
  ] },
  hotels: { icon: Building2, eyebrow: 'Hotels', title: 'Put hotel content and commercial setup on a clearer path to market.', intro: 'Give hotel teams an organised workspace for the information and controls B2B distribution depends on.', proof: 'Content · Rooms · Availability', sections: [
    { title: 'Content foundation', text: 'Maintain structured hotel, facility, policy and media information.', items: ['Core profile', 'Room content', 'Policy review'] },
    { title: 'Commercial setup', text: 'Prepare contracts and rate plans for controlled distribution.', items: ['Rate plans', 'Market conditions', 'Promotions'] },
    { title: 'Day-to-day control', text: 'Keep availability, allotments and restrictions visible to operating teams.', items: ['Availability calendar', 'Allotment coverage', 'Stop-sale review'] },
  ] },
  'travel-technology': { icon: Cable, eyebrow: 'Travel technology', title: 'Stable contracts for product and engineering teams.', intro: 'Connect through explicit boundaries that keep supplier behavior separate from core pricing and booking logic.', proof: 'Typed contracts · Idempotency · Observable errors', sections: [
    { title: 'Search and content', text: 'Work against predictable criteria and response shapes.', items: ['Destination and occupancy inputs', 'Mapped hotel identity', 'Rate source visibility'] },
    { title: 'Booking lifecycle', text: 'Design transactional calls around rechecks, idempotency and explicit state.', items: ['Prebook', 'Confirm', 'Cancel'] },
    { title: 'Operational support', text: 'Treat monitoring and exception handling as part of the integration contract.', items: ['Request tracing', 'Error taxonomy', 'Connection health'] },
  ] },
}

export const operationalPrinciples = [
  { icon: KeyRound, title: 'Controlled access', text: 'Tenant and permission boundaries belong in the platform, not in marketing-site assumptions.' },
  { icon: FileCheck2, title: 'Explicit decisions', text: 'Pricing, mapping and connector behavior should remain explainable and reviewable.' },
  { icon: BarChart3, title: 'Visible readiness', text: 'Surface coverage and configuration gaps before they become booking failures.' },
]
