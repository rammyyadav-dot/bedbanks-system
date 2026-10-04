'use client'

import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { getOpsWallets } from '@/lib/data/operations'
import type { WalletRow } from '@bedbanks/contracts'

export default function WalletsPage() {
  return (
    <OpsListPage<WalletRow>
      eyebrow="FINANCE" title="Accounts" description="The tenant house account (which holds and bookings post to today) and agency accounts. Balance is the sum of immutable ledger entries; available credit is credit limit plus that sum. The ledger is the only authority. Read-only."
      load={getOpsWallets} getRowId={w => w.id}
      emptyTitle="No accounts" emptyDescription="The query succeeded and this tenant has no account."
      columns={[
        { key: 'owner', header: 'Account', render: w => (w.owner === 'HOUSE' ? <Tag>house</Tag> : <span><Tag tone="ok">agency</Tag> {w.agency?.name ?? ''} {w.agency ? <code>{w.agency.code}</code> : null}</span>) },
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
