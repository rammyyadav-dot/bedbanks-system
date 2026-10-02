'use client'

import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, when } from '@/components/ops/ops-ui'
import { getOpsWallets } from '@/lib/data/operations'
import type { WalletRow } from '@bedbanks/contracts'

export default function WalletsPage() {
  return (
    <OpsListPage<WalletRow>
      eyebrow="FINANCE" title="Wallets" description="Balance is the sum of immutable ledger entries; available credit is credit limit plus that sum. The ledger is the only authority. Read-only."
      load={getOpsWallets} getRowId={w => w.id}
      emptyTitle="No wallets" emptyDescription="The query succeeded and this tenant has no wallet."
      columns={[
        { key: 'currency', header: 'Currency', render: w => w.currency },
        { key: 'limit', header: 'Credit limit', align: 'right', render: w => <Money minor={w.creditLimit} currency={w.currency} /> },
        { key: 'balance', header: 'Ledger balance', align: 'right', render: w => <Money minor={w.balanceMinor} currency={w.currency} /> },
        { key: 'available', header: 'Available credit', align: 'right', render: w => <Money minor={w.availableCreditMinor} currency={w.currency} /> },
        { key: 'entries', header: 'Entries', align: 'right', render: w => w.entryCount },
        { key: 'updated', header: 'Updated', render: w => when(w.updatedAt) },
      ]}
    />
  )
}
