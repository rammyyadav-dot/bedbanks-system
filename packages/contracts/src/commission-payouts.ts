import type { MinorString, Paged } from './operations'

/**
 * Dynamic, tier-based commission payouts to an agency for one closed period (ADR 0098). A finance user proposes a payout for an
 * agency's gross booked volume in a period; the tier and basis points are resolved server-side from that volume (never client
 * supplied), and a different finance user approves or rejects it. Approval posts one CREDIT to the agency account. Amounts are
 * integer minor units serialised as strings.
 */
export const AGENCY_COMMISSION_TIERS = ['BRONZE', 'SILVER', 'GOLD', 'ENTERPRISE'] as const
export type AgencyCommissionTierName = (typeof AGENCY_COMMISSION_TIERS)[number]

export const COMMISSION_PAYOUT_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const
export type CommissionPayoutStatusName = (typeof COMMISSION_PAYOUT_STATUSES)[number]

/** Writes answer 503 with COMMISSION_PAYOUTS_DISABLED unless the deployment sets COMMISSION_PAYOUTS_ENABLED=true. Reads always work. */
export const COMMISSION_PAYOUT_FAILURE = {
  disabled: 'COMMISSION_PAYOUT_DISABLED',
  invalid: 'COMMISSION_PAYOUT_INVALID',
  notFound: 'COMMISSION_PAYOUT_NOT_FOUND',
  agencyNotFound: 'COMMISSION_PAYOUT_AGENCY_NOT_FOUND',
  periodOverlap: 'COMMISSION_PAYOUT_PERIOD_OVERLAP',
  requestReused: 'COMMISSION_PAYOUT_REQUEST_REUSED',
  decided: 'COMMISSION_PAYOUT_DECIDED',
  ownProposal: 'COMMISSION_PAYOUT_OWN_PROPOSAL',
  changed: 'COMMISSION_PAYOUT_CHANGED',
} as const

export const commissionPayoutPermissions = { propose: 'finance.commission.propose', approve: 'finance.commission.approve' } as const

export interface CommissionPayoutProposeRequest {
  /** Client-generated idempotency key (8 to 80 characters). Retrying returns the same payout. */
  requestId: string
  agencyId: string
  /** YYYY-MM-DD, inclusive period; periodEnd must be after periodStart. */
  periodStart: string
  periodEnd: string
  currency: string
  /** The agency's gross booked volume for the period, as a non-negative whole number of minor units. The server resolves the tier and rate from this; neither is client supplied. */
  grossBookedMinor: string
}

export interface CommissionPayoutDecisionRequest { reason?: string }

export interface AgencyCommissionPayoutView {
  id: string
  number: string
  agencyId: string
  periodStart: string
  periodEnd: string
  currency: string
  grossBookedMinor: MinorString
  tier: AgencyCommissionTierName
  commissionBp: number
  amountMinor: MinorString
  status: CommissionPayoutStatusName
  proposedById: string
  proposedAt: string
  decidedById: string | null
  decidedAt: string | null
  decisionReason: string | null
  /** Set once approved: the CREDIT entry on the agency account. */
  ledgerEntryId: string | null
  /** For the CALLER: the endpoint still enforces permission and separation of duties. */
  canDecide: boolean
}

export type AgencyCommissionPayoutPage = Paged<AgencyCommissionPayoutView>
