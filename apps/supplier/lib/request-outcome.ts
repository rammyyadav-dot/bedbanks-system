export type SupplierRequestOutcome = 'denied' | 'timeout' | 'unavailable' | 'not_found' | 'unauthenticated'

function statusOf(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('status' in error)) return 0
  const status = error.status
  return typeof status === 'number' ? status : 0
}

/** Classify a supplier portal request. A timeout is not a permission denial and is not proof the write was skipped. */
export function supplierRequestOutcome(error: unknown): SupplierRequestOutcome {
  const status = statusOf(error)
  if (status === 0) return 'unavailable'
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'denied'
  if (status === 404) return 'not_found'
  if (status === 504) return 'timeout'
  return 'unavailable'
}

export function supplierReadFailureCopy(subject: string, outcome: SupplierRequestOutcome): string {
  if (outcome === 'denied') return `You do not have permission to view ${subject} for this organization. Nothing else is shown.`
  if (outcome === 'timeout') return `The request timed out. No ${subject} are shown and nothing was changed. Try again.`
  if (outcome === 'not_found') return `That ${subject} record is not in this organization. Nothing else is shown.`
  return `${subject[0]?.toUpperCase() ?? ''}${subject.slice(1)} could not be loaded. No substitute data is shown.`
}

export function supplierDraftFailureCopy(outcome: SupplierRequestOutcome): string {
  if (outcome === 'denied') return 'You cannot edit this draft. The note was not changed.'
  if (outcome === 'not_found') return 'This room is not in your organization. The note was not changed.'
  if (outcome === 'timeout') return 'The request timed out after it was sent. Reload the room before changing the note again. A second save could overwrite a note that was stored.'
  return 'The draft was not saved. No preview note was stored.'
}

export function supplierWorkspaceFailureCopy(outcome: SupplierRequestOutcome): string {
  if (outcome === 'denied') return 'You do not have permission to open this supplier workspace. No organization data is shown.'
  if (outcome === 'timeout') return 'The supplier workspace timed out. No organization data is shown and nothing was changed. Try again.'
  return 'The supplier workspace cannot be loaded because the API request failed. No preview data is shown.'
}

export function supplierOrganizationFailureCopy(outcome: SupplierRequestOutcome): string {
  if (outcome === 'timeout') return 'The organization check timed out. This workspace was not switched. Try again before viewing hotels.'
  return 'That organization is not available for this session.'
}
