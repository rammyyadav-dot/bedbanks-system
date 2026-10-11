/**
 * Hotel Setup contracts (ADR 0021): descriptive and operational hotel content, kept apart from commercial readiness.
 *
 * - A profile may be saved incomplete. Publication (`contentStatus` COMPLETE) is validated separately against
 *   HOTEL_PUBLICATION_REQUIREMENTS, evaluated by the API.
 * - Contacts are private: no Agent, Website or supplier API returns them.
 * - Concurrency is a single opaque `concurrencyToken`; a stale token is rejected with HOTEL_SETUP_STALE.
 * - Policies here are hotel information only. Rate-specific cancellation terms live on contracts and are never overwritten.
 */
export const HOTEL_CONTACT_KINDS = ['reservations', 'commercial', 'finance', 'emergency'] as const;
export type HotelContactKind = (typeof HOTEL_CONTACT_KINDS)[number];
export interface HotelContact { name?: string | null; email?: string | null; phone?: string | null }
export type HotelContacts = Partial<Record<HotelContactKind, HotelContact>>;

export const HOTEL_POLICY_KEYS = ['children', 'extraBeds', 'pets', 'accessibility', 'localCharges'] as const;
export type HotelPolicyKey = (typeof HOTEL_POLICY_KEYS)[number];
export type HotelPolicies = Partial<Record<HotelPolicyKey, string | null>>;
export const HOTEL_POLICY_LABELS: Record<HotelPolicyKey, string> = {
  children: 'Children', extraBeds: 'Extra beds', pets: 'Pets', accessibility: 'Accessibility', localCharges: 'Local charges (paid at the hotel)',
};

export const HOTEL_PROFILE_STATUSES = ['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED', 'ARCHIVED'] as const;
export type HotelProfileStatus = (typeof HOTEL_PROFILE_STATUSES)[number];
/** Property types the UI offers. The API accepts any non-empty value that is already used elsewhere in the tenant. */
export const HOTEL_PROPERTY_TYPES = ['HOTEL', 'RESORT', 'APARTMENT', 'VILLA', 'HOSTEL', 'GUESTHOUSE'] as const;

export const EXTERNAL_IDENTIFIER_SCHEME_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
export const KNOWN_EXTERNAL_SCHEMES = ['GIATA'] as const;
export interface HotelExternalIdentifierView { scheme: string; value: string; createdAt: string }

export type HotelSetupSection = 'identity' | 'location' | 'classification' | 'content' | 'operations' | 'contacts' | 'governance' | 'rooms';

/** Fields required to publish a hotel to Agents. A profile may be saved without them. */
export const HOTEL_PUBLICATION_REQUIREMENTS = [
  { key: 'NAME', label: 'Hotel name', section: 'identity' },
  { key: 'PROPERTY_TYPE', label: 'Property type', section: 'identity' },
  { key: 'COUNTRY', label: 'Country', section: 'location' },
  { key: 'CITY', label: 'City', section: 'location' },
  { key: 'ADDRESS', label: 'Street address', section: 'location' },
  { key: 'COORDINATES', label: 'Latitude and longitude', section: 'location' },
  { key: 'TIME_ZONE', label: 'IANA time zone', section: 'location' },
  { key: 'STAR_CATEGORY', label: 'Verified star category (1-5)', section: 'classification' },
  { key: 'SHORT_DESCRIPTION', label: 'Short description', section: 'content' },
  { key: 'CHECK_IN_OUT', label: 'Check-in and check-out times', section: 'operations' },
  { key: 'RESERVATIONS_CONTACT', label: 'Reservations contact (name and email or phone)', section: 'contacts' },
  { key: 'ACTIVE_ROOM', label: 'At least one active canonical room', section: 'rooms' },
] as const satisfies ReadonlyArray<{ key: string; label: string; section: HotelSetupSection }>;
export type HotelPublicationRequirementKey = (typeof HOTEL_PUBLICATION_REQUIREMENTS)[number]['key'];

export interface HotelRequirementResult { key: HotelPublicationRequirementKey; label: string; section: HotelSetupSection; met: boolean; detail: string }
export interface HotelCompleteness { requirements: HotelRequirementResult[]; met: number; total: number; percent: number; publishable: boolean }

export interface HotelSetupView {
  generatedAt: string
  hotelId: string
  /** Opaque. Send it back as `expectedToken`; a stale value is rejected. */
  concurrencyToken: string
  profileExists: boolean
  identity: { name: string; propertyType: string; legalName: string | null; chainName: string | null; brandName: string | null; code: string | null; externalIdentifiers: HotelExternalIdentifierView[] }
  location: { countryCode: string; city: string; area: string | null; address: string | null; postalCode: string | null; latitude: string | null; longitude: string | null; timeZone: string }
  classification: { starRating: number | null; source: string | null; verified: boolean; verifiedAt: string | null; verifiedById: string | null }
  content: { shortDescription: string | null; fullDescription: string | null; languages: string[] }
  operations: { checkInTime: string | null; checkOutTime: string | null; notes: string | null }
  /** Private. Returned only to callers holding supply.hotels.manage. */
  contacts: HotelContacts | null
  policies: HotelPolicies
  governance: { status: HotelProfileStatus; sourceSystem: string | null; ownerUserId: string | null; /** Resolved for display; null when unset or the user is no longer a tenant member. */ owner: HotelOwnerCandidate | null; approvedById: string | null; approvedAt: string | null; updatedById: string | null; updatedAt: string }
  rooms: { active: number; total: number }
  completeness: HotelCompleteness
  /** The open (pending or approved) publication request, if any. Present on the detail read only. */
  publication?: HotelPublicationApproval | null
}

/** A tenant member who may be named the internal owner of a hotel profile. Returned only to callers holding supply.hotels.manage. */
export interface HotelOwnerCandidate { userId: string; name: string | null; email: string }

/** Every field is optional: an omitted field is unchanged, `null` clears it. Contacts, policies and identifiers replace the stored set when sent. */
export interface HotelSetupSave {
  /** Client-generated idempotency key. Repeating a save with the same key returns the stored result and changes nothing. */
  idempotencyKey: string
  expectedToken: string
  reason?: string
  name?: string; propertyType?: string; legalName?: string | null; chainName?: string | null; brandName?: string | null
  countryCode?: string; city?: string; area?: string | null; address?: string | null; postalCode?: string | null
  latitude?: string | null; longitude?: string | null; timeZone?: string
  starRating?: number | null; starSource?: string | null; starVerified?: boolean
  shortDescription?: string | null; fullDescription?: string | null; languages?: string[]
  checkInTime?: string | null; checkOutTime?: string | null; operationalNotes?: string | null
  contacts?: HotelContacts; policies?: HotelPolicies
  sourceSystem?: string | null; ownerUserId?: string | null
  externalIdentifiers?: Array<{ scheme: string; value: string }>
}

export interface HotelSetupStatusChange { idempotencyKey: string; expectedToken: string; to: HotelProfileStatus; reason: string }
/** `auditRequestId` is the server request id recorded on the audit event. */
export interface HotelSetupSaved { setup: HotelSetupView; auditRequestId: string; replayed: boolean }

/** Publishing a hotel needs two people (ADR 0022). The maker requests, a different holder of supply.hotels.manage approves, then it is applied once. */
export interface HotelPublicationApproval {
  id: string
  status: string
  reason: string
  requestedById: string
  decidedById: string | null
  decisionReason: string | null
  canDecide: boolean
  canCancel: boolean
  canExecute: boolean
  /** True when the hotel was edited after the request; applying it would be refused and a new request is needed. */
  changedSinceRequest: boolean
}
export interface HotelPublicationRequest { requestId: string; expectedToken: string; reason: string }
export interface HotelPublicationDecision { reason: string }
export interface HotelPublicationResult { approval: HotelPublicationApproval; setup: HotelSetupView }

/** Suggestions from canonical tenant hotels, not a parallel geographical master. New destinations remain explicitly editable. */
export interface HotelLocationOptions { countries: string[]; cities: string[]; countryCode: string | null; capped: boolean }
