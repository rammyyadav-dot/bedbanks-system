import type { HotelSetupSave } from '@bedbanks/contracts'

/**
 * Bulk owner assignment is a loop over the existing single-hotel Setup save: every hotel is authorized, validated, version-checked,
 * idempotent and audited by the API exactly as a manual edit. There is no bulk endpoint, so there is no bulk-only bypass.
 * One failure never aborts the rest; each hotel reports its own outcome.
 */
export const BULK_OWNER_MAX = 25
export const BULK_REASON_MIN = 3

export type BulkOwnerOutcome = { hotelId: string; status: 'assigned' | 'unchanged' | 'failed'; message?: string }
export interface BulkOwnerDeps {
  getToken(hotelId: string): Promise<{ token: string; currentOwnerUserId: string | null }>
  save(hotelId: string, body: HotelSetupSave): Promise<{ replayed: boolean }>
  newKey(): string
}

export function bulkOwnerProblem(hotelIds: readonly string[], ownerUserId: string | null, reason: string): string | null {
  if (hotelIds.length === 0) return 'Select at least one hotel.'
  if (hotelIds.length > BULK_OWNER_MAX) return `At most ${BULK_OWNER_MAX} hotels can be updated at once.`
  if (new Set(hotelIds).size !== hotelIds.length) return 'The selection contains duplicates.'
  if (reason.trim().length < BULK_REASON_MIN) return 'A reason is required.'
  if (ownerUserId === '') return 'Choose an owner, or clear the owner explicitly.'
  return null
}

/** `ownerUserId: null` clears the owner. Keys are supplied per hotel so a retry of the same run replays instead of repeating. */
export async function assignOwners(hotelIds: readonly string[], ownerUserId: string | null, reason: string, deps: BulkOwnerDeps, keys: ReadonlyMap<string, string> = new Map()): Promise<BulkOwnerOutcome[]> {
  const problem = bulkOwnerProblem(hotelIds, ownerUserId, reason)
  if (problem) throw new Error(problem)
  const out: BulkOwnerOutcome[] = []
  for (const hotelId of hotelIds) {
    try {
      const { token, currentOwnerUserId } = await deps.getToken(hotelId)
      if (currentOwnerUserId === ownerUserId) { out.push({ hotelId, status: 'unchanged' }); continue }
      await deps.save(hotelId, { idempotencyKey: keys.get(hotelId) ?? deps.newKey(), expectedToken: token, reason: reason.trim(), ownerUserId })
      out.push({ hotelId, status: 'assigned' })
    } catch (error) {
      out.push({ hotelId, status: 'failed', message: error instanceof Error ? error.message : 'The change was not saved.' })
    }
  }
  return out
}
