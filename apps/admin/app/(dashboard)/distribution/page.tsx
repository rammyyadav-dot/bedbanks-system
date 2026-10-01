import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="DISTRIBUTION" title="Search Monitor" reason="Supplier search monitoring is not enabled. No live supplier is contacted from the Admin console in the Dubai MVP." />
}
