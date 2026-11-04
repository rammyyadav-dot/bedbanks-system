import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="PRICING" title="Pricing Simulator" reason={<>The pricing simulator is withdrawn: it was not backed by the authoritative pricing engine. Use the <Link href="/sellability">Sellability inspector</Link> to verify commercial setup.</>} />
}
