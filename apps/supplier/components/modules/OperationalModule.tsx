import { SupplyWorkflowUnavailable } from '../supply/SupplyWorkflowUnavailable'

export function OperationalModule({ title = 'Unavailable' }: { title?: string }) {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title={title}
      description="This module is not connected. No record is created or published from this screen."
    />
  )
}
