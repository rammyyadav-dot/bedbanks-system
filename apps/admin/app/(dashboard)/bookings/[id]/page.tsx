import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="BOOKINGS" title="Booking detail" reason="Booking operations are not enabled for the Dubai MVP. Transactional booking remains behind release certification, so no booking records, vouchers, payments or cancellation policies are shown." />
}
