import { SupplyWorkflowUnavailable } from '../supply/SupplyWorkflowUnavailable'

export function HotelsView() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Portfolio"
      title="Property preview removed"
      description="Mapped hotels are loaded from the authenticated extranet API."
    />
  )
}
