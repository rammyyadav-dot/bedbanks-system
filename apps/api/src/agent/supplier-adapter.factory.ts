import { AggregatingSupplierAdapter } from './aggregating-supplier.adapter'
import { CONTRACTED_OFFER_PREFIX, CONTRACTED_REFERENCE_PREFIX } from './contracted-inventory.adapter'
import type { SupplierAdapter } from './supplier.port'

const DEFAULT_SEARCH_DEADLINE_MS = 10_000
/** Below the agent search single-flight lock (12 s), so a search cannot outlive its lock. */
const MAX_SEARCH_DEADLINE_MS = 11_000

/**
 * Chooses the agent `SUPPLIER_ADAPTER` (ADR 0075). Off by default: contracted inventory is used directly, as before.
 * `AGENT_SUPPLIER_AGGREGATION=enabled` puts it behind `AggregatingSupplierAdapter`, which adds a search deadline
 * (`AGENT_SEARCH_DEADLINE_MS`, default 10 s) and one structured log line per supplier per search. With contracted
 * inventory as the only member, names, caching, routing and the mutation journal are unchanged; only the deadline is new.
 * External suppliers join here once each has a certified connector and a `SharedConnectorGate`.
 */
export function supplierAdapterFromEnvironment(contracted: SupplierAdapter, env: Record<string, string | undefined> = process.env): SupplierAdapter {
  const mode = env.AGENT_SUPPLIER_AGGREGATION?.trim() ?? ''
  if (mode === '' || mode === 'disabled') return contracted
  if (mode !== 'enabled') throw new Error('AGENT_SUPPLIER_AGGREGATION must be "enabled" or "disabled"')
  const raw = env.AGENT_SEARCH_DEADLINE_MS?.trim()
  const deadline = raw ? Number(raw) : DEFAULT_SEARCH_DEADLINE_MS
  if (!Number.isSafeInteger(deadline) || deadline < 1_000 || deadline > MAX_SEARCH_DEADLINE_MS) {
    throw new Error(`AGENT_SEARCH_DEADLINE_MS must be an integer from 1000 to ${MAX_SEARCH_DEADLINE_MS}`)
  }
  return new AggregatingSupplierAdapter([
    { adapter: contracted, offerPrefix: CONTRACTED_OFFER_PREFIX, referencePrefix: CONTRACTED_REFERENCE_PREFIX, searchTimeoutMs: deadline },
  ], { searchDeadlineMs: deadline })
}
