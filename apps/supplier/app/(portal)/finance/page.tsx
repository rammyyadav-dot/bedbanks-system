import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'

export default function Page() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title="Finance"
      description="Settlement figures are not available."
    />
  )
}
