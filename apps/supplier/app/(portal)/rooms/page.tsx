import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'

export default function Page() {
  return (
    <SupplyWorkflowUnavailable
      eyebrow="Unavailable"
      title="Rooms"
      description="A portfolio-wide room editor is not available. Open a mapped hotel to view its rooms."
    />
  )
}
