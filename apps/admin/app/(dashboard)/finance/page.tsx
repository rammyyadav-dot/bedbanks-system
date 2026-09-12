import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { getWallets, getPayments } from '@/lib/data'

export default async function FinancePage() {
  const [wallets, payments] = await Promise.all([getWallets(), getPayments()])
  const totalBalance = wallets.reduce((s, w) => s + w.availableCredit, 0)
  const outstanding = wallets.reduce((s, w) => s + w.usedCredit, 0)
  const paymentsToday = payments.filter((p) => p.date === '2026-09-08').reduce((s, p) => s + p.amount, 0)
  const refunds = 356.5

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="FINANCE"
        title="Finance"
        description="Wallet balances, ledger, and payments across all tenants."
        actions={<div style={{ display: 'flex', gap: 8 }}><Link href="/finance/wallets" className="admin-btn">Wallets</Link><Link href="/finance/ledger" className="admin-btn">Ledger</Link><Link href="/finance/payments" className="admin-btn">Payments</Link></div>}
      />
      <div className="admin-summary-cards">
        <StatCard label="Total Wallet Balance" value={`$${totalBalance.toLocaleString()}`} />
        <StatCard label="Outstanding Credit" value={`$${outstanding.toLocaleString()}`} />
        <StatCard label="Payments Today" value={`$${paymentsToday.toLocaleString()}`} />
        <StatCard label="Refunds" value={`$${refunds.toLocaleString()}`} />
      </div>
    </div>
  )
}
