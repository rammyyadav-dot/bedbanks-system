import { SupplyWorkflowUnavailable } from '../../../../components/supply/SupplyWorkflowUnavailable'

export default function Page() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title="Add property"
      description="Creating a property is not available."
    />
  )
}
