import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return (
    <FeatureUnavailable
      eyebrow="DISTRIBUTION"
      title="Search monitor index"
      description="This address is not the search monitor."
      reason={<>Recorded Agent search outcomes are on <Link href="/distribution/search-monitor">Search monitor</Link>. That screen reads audit events. It does not contact a supplier, and live supplier connectivity is not certified.</>}
    />
  )
}
