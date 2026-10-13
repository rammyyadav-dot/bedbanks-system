import { RatePlanForm } from '@/components/commercial/RatePlanForm'

// A new plan continues straight into the guided setup, so nobody has to know what to fill in next.
export default function NewRatePlanPage() {
  return <RatePlanForm afterCreate="setup" />
}
