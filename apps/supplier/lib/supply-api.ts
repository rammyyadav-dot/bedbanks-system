export type SupplyWorkflowAvailability = { status: 'unavailable'; reason: string }

/**
 * Unsupported supplier modules stay unavailable even when an API URL is configured.
 * A configured URL must not turn these screens into a successful workflow.
 */
export function getSupplyWorkflowAvailability(): SupplyWorkflowAvailability {
  return {
    status: 'unavailable',
    reason: 'This module is not connected. No record is created, saved, exported, uploaded, invited, or published from this screen.',
  }
}
