import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="BOOKINGS" title="Cancellations" reason="Cancellation transactions are not enabled for the Dubai MVP. They remain behind release certification." />
}
