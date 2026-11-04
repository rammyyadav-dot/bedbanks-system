import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return (
    <FeatureUnavailable
      eyebrow="FINANCE"
      title="Payments"
      description="Payment capture is not a certified workflow."
      reason={<>This page posts nothing and shows no balances. Read-only account positions are on <Link href="/finance/wallets">Wallets</Link>.</>}
    />
  )
}
