import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'

export default function Page() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title="Rates"
      description="Rates are not available and are not being saved."
    />
  )
}
