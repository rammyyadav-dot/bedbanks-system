export type SupplyWorkflowAvailability =
  | { status: 'available'; apiBaseUrl: string }
  | { status: 'unavailable'; reason: string }

/**
 * This boundary deliberately exposes no mock supply data. It can be replaced with
 * reviewed API calls once Issue #57 delivers authenticated supplier endpoints.
 */
export function getSupplyWorkflowAvailability(): SupplyWorkflowAvailability {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL

  if (!apiBaseUrl) {
    return {
      status: 'unavailable',
      reason: 'The authenticated supply-workflow API is not configured in this environment.',
    }
  }

  return { status: 'available', apiBaseUrl }
}
