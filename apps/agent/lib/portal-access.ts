/** Agent permission keys. The API remains authoritative; this list only drives presentation. */
export const AGENT_CAPABILITY = {
  search: 'hotel.search',
  prebook: 'booking.prebook',
  createBooking: 'booking.create',
  cancelBooking: 'booking.cancel',
  viewFinance: 'finance.read',
  auditRead: 'audit.read',
  reconcileBookings: 'booking.reconcile',
  viewBookings: 'booking.read',
} as const

export type AgentCapability = (typeof AGENT_CAPABILITY)[keyof typeof AGENT_CAPABILITY]

const KNOWN = new Set<string>(Object.values(AGENT_CAPABILITY))

/** Keeps only known agent capabilities, in a stable order, and drops anything else. */
export function capabilitiesFromContext(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  const present = new Set(value.filter((item): item is AgentCapability => typeof item === 'string' && KNOWN.has(item)))
  return (Object.values(AGENT_CAPABILITY) as AgentCapability[]).filter((capability) => present.has(capability))
}

export type CertificationFlags = {
  bookingEnabled: boolean
  bookingServicingEnabled: boolean
  fundingEnabled: boolean
}

export type ActionGate = { shown: boolean; enabled: boolean; message: string | null }

const NOT_CERTIFIED = {
  hold: 'You can hold rates, but booking is not certified for this workspace yet. Nothing is held.',
  createBooking: 'You can create bookings, but confirmation is not certified for this workspace yet.',
  viewBookings: 'You can view bookings, but booking history is not certified for this workspace yet.',
  cancel: 'You can cancel bookings, but cancellation is not certified for this workspace yet.',
  documents: 'You can open booking documents, but documents are not certified for this workspace yet.',
  funding: 'You can declare payments, but funding declarations are not enabled for this workspace yet. A declaration would not credit the wallet.',
} as const

function gate(allowed: boolean, certified: boolean, message: string): ActionGate {
  if (!allowed) return { shown: false, enabled: false, message: null }
  if (!certified) return { shown: true, enabled: false, message }
  return { shown: true, enabled: true, message: null }
}

/**
 * UI exposure for one tenant's effective capabilities plus the deployment certification flags.
 * Funding declarations use booking.prebook because that is the permission the funding API checks.
 */
export function portalAccess(capabilities: readonly string[], flags: CertificationFlags) {
  const allowed = (capability: AgentCapability) => capabilities.includes(capability)
  return {
    search: gate(allowed(AGENT_CAPABILITY.search), true, ''),
    finance: gate(allowed(AGENT_CAPABILITY.viewFinance), true, ''),
    funding: gate(allowed(AGENT_CAPABILITY.prebook), flags.fundingEnabled, NOT_CERTIFIED.funding),
    hold: gate(allowed(AGENT_CAPABILITY.prebook), flags.bookingEnabled, NOT_CERTIFIED.hold),
    createBooking: gate(allowed(AGENT_CAPABILITY.createBooking), flags.bookingEnabled, NOT_CERTIFIED.createBooking),
    viewBookings: gate(allowed(AGENT_CAPABILITY.viewBookings), flags.bookingServicingEnabled, NOT_CERTIFIED.viewBookings),
    cancel: gate(allowed(AGENT_CAPABILITY.cancelBooking), flags.bookingServicingEnabled, NOT_CERTIFIED.cancel),
    documents: gate(allowed(AGENT_CAPABILITY.viewBookings), flags.bookingServicingEnabled, NOT_CERTIFIED.documents),
  }
}

export type PortalAccess = ReturnType<typeof portalAccess>

export const CLOSED_ACCESS: PortalAccess = portalAccess([], { bookingEnabled: false, bookingServicingEnabled: false, fundingEnabled: false })
