import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="FINANCE" title="Ledger" reason="Wallet, ledger and payment operations are not enabled for the Dubai MVP. Financial mutations remain behind release certification and no balances are displayed." />
}
