import { fundingEnabled } from '../funding/funding.service'
import { bookingTransactionConfigured } from './booking-transaction.database'
import { bookingEnabled, bookingServicingEnabled } from './booking-transaction.service'

/**
 * What the agent portal may show. Each flag is the conjunction the matching route already enforces
 * (ADR 0101, ADR 0113). A raw BOOKING_ENABLED or FUNDING_ENABLED string is not enough:
 * booking routes also require a distinct booking-transaction credential, and the servicing switch never opens new sales.
 */
export function portalCertification(env: Record<string, string | undefined> = process.env) {
  const boundary = bookingTransactionConfigured(env)
  return {
    /** Hold, prebook and confirm. */
    bookingEnabled: bookingEnabled(env) && boundary,
    /** List, detail, documents, cancellation and recovery. */
    bookingServicingEnabled: bookingServicingEnabled(env) && boundary,
    /** Funding declaration writes. Receipt reads stay on the prebook permission alone. */
    fundingEnabled: fundingEnabled(env),
  }
}
