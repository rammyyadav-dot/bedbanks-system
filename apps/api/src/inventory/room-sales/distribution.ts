import { simulatedDistribution } from './engine'

/** Channel delivery is not a live supplier connection. Callers must show `label` and `simulated`. */
export interface SalesDistributionAdapter {
  readonly simulated: true
  readonly label: string
  deliver(input: { jobId: string; payloadHash: string; forceFailure: boolean }): Promise<{ acknowledged: boolean; error?: string }>
}

export class SimulatedSalesDistributionAdapter implements SalesDistributionAdapter {
  readonly simulated = true as const
  readonly label = simulatedDistribution.label
  async deliver(input: { forceFailure: boolean }): Promise<{ acknowledged: boolean; error?: string }> {
    if (input.forceFailure) return { acknowledged: false, error: 'Simulated channel timeout' }
    return { acknowledged: true }
  }
}
