import { isException, type Finding, type FindingType } from '@bedbanks/money'
import type { ReconExceptionStatus } from '@bedbanks/contracts'

/** What a re-run needs to know about a finding that already exists for the statement. */
export interface StoredFinding {
  id: string
  findingKey: string
  status: ReconExceptionStatus
  isException: boolean
  type: FindingType
  bookingId: string | null
  currency: string
  statementMinor: bigint | null
  ledgerMinor: bigint | null
  varianceMinor: bigint | null
}

export type SyncOp =
  | { op: 'create'; finding: Finding }
  /** Facts changed. `reopen`: a decision waiting for a second person was made on stale facts and goes back to OPEN. `autoResolve`: the difference is gone. */
  | { op: 'refresh'; id: string; finding: Finding; reopen: boolean; autoResolve: boolean }
  /** The finding no longer applies (for example a ledger gap that closed). */
  | { op: 'autoResolve'; id: string }
  | { op: 'keep'; id: string }

const sameFacts = (stored: StoredFinding, f: Finding) =>
  stored.type === f.type && stored.bookingId === f.bookingId && stored.currency === f.currency &&
  stored.statementMinor === f.statementMinor && stored.ledgerMinor === f.ledgerMinor && stored.varianceMinor === f.varianceMinor

/**
 * The persistence plan of a re-run. Pure and deterministic. A RESOLVED finding never changes. A finding whose facts are unchanged keeps its workflow state, so a re-run
 * never discards a dispute or a pending decision. A decision pending a second person is reopened if the facts it was based on changed. A difference that disappeared
 * closes itself (AUTO_MATCHED); it is never left open for a person to chase.
 */
export function planSync(existing: readonly StoredFinding[], computed: readonly Finding[]): SyncOp[] {
  const byKey = new Map(existing.map((e) => [e.findingKey, e]))
  const seen = new Set<string>()
  const ops: SyncOp[] = []
  for (const f of computed) {
    seen.add(f.key)
    const stored = byKey.get(f.key)
    if (!stored) { ops.push({ op: 'create', finding: f }); continue }
    if (stored.status === 'RESOLVED' || sameFacts(stored, f)) { ops.push({ op: 'keep', id: stored.id }); continue }
    ops.push({ op: 'refresh', id: stored.id, finding: f, reopen: stored.status === 'PENDING_APPROVAL', autoResolve: !isException(f.type) })
  }
  for (const stored of existing) {
    if (seen.has(stored.findingKey)) continue
    ops.push(stored.status !== 'RESOLVED' && stored.isException ? { op: 'autoResolve', id: stored.id } : { op: 'keep', id: stored.id })
  }
  return ops
}
