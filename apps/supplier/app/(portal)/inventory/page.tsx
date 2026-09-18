import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'

export default function InventoryPage() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Inventory staging"
      title="Inventory submissions"
      description="Stage manual rates and availability for validation and authorised review."
    />
  )
}
