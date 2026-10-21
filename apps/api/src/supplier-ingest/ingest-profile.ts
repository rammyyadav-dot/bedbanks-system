import type { ExtractionSpec } from '@bedbanks/connectors-core'

export type IngestFeedKind = 'RATES' | 'ALLOTMENTS' | 'CANCELLATION_POLICIES'

/**
 * How one upstream source's documents become canonical records (ADR 0080). A profile is configuration, not code: a document format and an extraction spec per feed kind,
 * plus the freshness the operator accepts. Provider field names live only here; everything after extraction is the shared, provider-neutral normalizer (ADR 0077).
 */
export interface IngestProfile {
  /** Stable key, for example `channel-manager-x`. Never a tenant or supplier id: the job names those, from server-side configuration. */
  key: string
  format: 'xml' | 'json'
  /** A kind without a spec is unsupported by this source and its jobs are refused, never silently skipped. */
  specs: Partial<Record<IngestFeedKind, ExtractionSpec>>
  /**
   * The price basis this source's rates carry. Declared, never defaulted. Only 'NET' can ever be promoted (ADR 0082): a feed does not publish an agent-facing SELL price, so a profile that
   * declares 'SELL' is refused at registration. Left undeclared, the source's data can be ingested and resolved but never promoted.
   */
  amountBasis?: 'NET' | 'SELL'
  /** Observations expire this long after receipt (ADR 0030 #7). Required: no unexpiring supplier data. */
  freshnessMs: number
  /** Stay dates beyond `today + horizonDays` are rejected. Default from the normalizer. */
  horizonDays?: number
  /** Reject ratio (basis points) above which a feed is FAILED rather than PARTIAL. Default 5000. */
  maxRejectBasisPoints?: number
  /** Needed only when the source states cancellation rules as "N days before arrival" (ADR 0077). */
  cancellation?: { hotelUtcOffset: string; cutoffTime: string }
}

const MIN_FRESHNESS_MS = 60_000
const MAX_FRESHNESS_MS = 7 * 24 * 3_600_000

export class IngestProfileRegistry {
  private readonly profiles = new Map<string, IngestProfile>()

  register(profile: IngestProfile): void {
    if (!/^[a-z][a-z0-9-]{2,62}$/.test(profile.key)) throw new Error('Ingest profile key must match [a-z][a-z0-9-]{2,62}')
    if (this.profiles.has(profile.key)) throw new Error(`Ingest profile ${profile.key} is already registered`)
    if (profile.format !== 'xml' && profile.format !== 'json') throw new Error('Ingest profile format must be xml or json')
    if (profile.amountBasis === 'SELL') throw new Error('An ingest profile may not declare SELL: supplier feeds carry NET rates and markup is applied by the markup rules (ADR 0082)')
    if (profile.amountBasis !== undefined && profile.amountBasis !== 'NET') throw new Error('Ingest profile amountBasis must be NET when declared')
    if (Object.keys(profile.specs).length === 0) throw new Error('Ingest profile needs at least one feed spec')
    if (!Number.isInteger(profile.freshnessMs) || profile.freshnessMs < MIN_FRESHNESS_MS || profile.freshnessMs > MAX_FRESHNESS_MS) throw new Error('Ingest profile freshnessMs must be between one minute and seven days')
    this.profiles.set(profile.key, Object.freeze({ ...profile }))
  }

  get(key: string): IngestProfile | undefined { return this.profiles.get(key) }
  size(): number { return this.profiles.size }
}
