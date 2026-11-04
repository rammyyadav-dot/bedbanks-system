import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return (
    <FeatureUnavailable
      eyebrow="FINANCE"
      title="Finance"
      description="This address is not a finance workspace."
      reason={<>Read-only wallets and the ledger are separate live screens: <Link href="/finance/wallets">Wallets</Link> and <Link href="/finance/ledger">Ledger</Link>. Funding, settlement, period close and other money movement are not production-certified. This page shows no balances and posts nothing.</>}
    />
  )
}
