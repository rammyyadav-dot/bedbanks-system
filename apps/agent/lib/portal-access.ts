import { shouldApplyTenantResponse } from './tenant-response'

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

/**
 * Certification flags from GET /agent/context. These are the route gates, not the raw environment strings:
 * booking flags already include the booking-transaction credential, and funding is the declaration write.
 */
export type CertificationFlags = {
  bookingEnabled: boolean
  bookingServicingEnabled: boolean
  fundingEnabled: boolean
}

export type ActionGate = { shown: boolean; enabled: boolean; message: string | null }

/** An action is shown only when this tenant's grant and the route's certification gate both pass. Otherwise it stays hidden. */
function gate(allowed: boolean, certified: boolean): ActionGate {
  if (allowed && certified) return { shown: true, enabled: true, message: null }
  return { shown: false, enabled: false, message: null }
}

/**
 * UI exposure for one tenant's effective capabilities plus the deployment certification flags.
 * Funding receipts use booking.prebook because that is the permission the funding read checks.
 * Declaring a receipt also requires funding to be certified. Booking actions require the matching sales or servicing gate.
 */
export function portalAccess(capabilities: readonly string[], flags: CertificationFlags) {
  const allowed = (capability: AgentCapability) => capabilities.includes(capability)
  return {
    search: gate(allowed(AGENT_CAPABILITY.search), true),
    finance: gate(allowed(AGENT_CAPABILITY.viewFinance), true),
    fundingReceipts: gate(allowed(AGENT_CAPABILITY.prebook), true),
    funding: gate(allowed(AGENT_CAPABILITY.prebook), flags.fundingEnabled),
    hold: gate(allowed(AGENT_CAPABILITY.prebook), flags.bookingEnabled),
    createBooking: gate(allowed(AGENT_CAPABILITY.createBooking), flags.bookingEnabled),
    viewBookings: gate(allowed(AGENT_CAPABILITY.viewBookings), flags.bookingServicingEnabled),
    cancel: gate(allowed(AGENT_CAPABILITY.cancelBooking), flags.bookingServicingEnabled),
    documents: gate(allowed(AGENT_CAPABILITY.viewBookings), flags.bookingServicingEnabled),
    recover: gate(allowed(AGENT_CAPABILITY.reconcileBookings), flags.bookingServicingEnabled),
  }
}

export type PortalAccess = ReturnType<typeof portalAccess>

export const CLOSED_ACCESS: PortalAccess = portalAccess([], { bookingEnabled: false, bookingServicingEnabled: false, fundingEnabled: false })

type TenantGrants = CertificationFlags & {
  capabilityTenantId: string
  capabilities: readonly string[]
}

/**
 * Grants apply only when the server named this tenant and it is still the selected workspace.
 * A client-supplied tenant id is not evidence, and a previous tenant's capabilities stay closed.
 */
export function accessForTenant(requestedTenant: string, activeTenant: string, context: TenantGrants): PortalAccess {
  if (!shouldApplyTenantResponse(requestedTenant, context.capabilityTenantId)) return CLOSED_ACCESS
  if (!shouldApplyTenantResponse(requestedTenant, activeTenant)) return CLOSED_ACCESS
  return portalAccess(context.capabilities, context)
}
