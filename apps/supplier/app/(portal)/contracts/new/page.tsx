import { SupplyWorkflowUnavailable } from '../../../../components/supply/SupplyWorkflowUnavailable'

export default function Page() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title="New contract"
      description="Creating a contract is not available."
    />
  )
}
