import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

/** Cancellation voucher dispatch stays on the API. It is not an Admin navigation target and this page posts nothing. */
export default function Page() {
  return <FeatureUnavailable eyebrow="COMMUNICATIONS" title="Notifications" reason="Notification delivery and cancellation voucher dispatch are not an Admin workspace. This page shows no records and sends nothing." />
}
