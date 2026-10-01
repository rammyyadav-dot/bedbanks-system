import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'

export default function Page() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title="Invoices"
      description="Invoices and settlement figures are not available."
    />
  )
}
