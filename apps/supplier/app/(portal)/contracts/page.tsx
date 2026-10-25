import { BookOpenCheck, CircleCheck, Tags } from 'lucide-react'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Pager } from '../../../components/ui/Pager'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import { SummaryStrip } from '../../../components/ui/SummaryStrip'
import { PageHeader } from '../../../components/ui/PageHeader'
import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'
import { listContracts } from '../../../lib/supplier-api'
import { loadPortal } from '../../../lib/portal'

export default async function ContractsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready') return null
  if (!portal.organization) {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Contracts" description="No supplier organization is available for this account." />
  }
  if (!portal.permissions.includes('supplier.extranet.contracts.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Contracts" description="This membership cannot read contracts." />
  }
  try {
    const raw = (await searchParams).cursor
    const cursor = typeof raw === 'string' && raw.length > 0 && raw.length <= 700 ? raw : undefined
    const { contracts, nextCursor } = await listContracts({ cursor, limit: 25 })
    const active = contracts.filter((contract) => contract.status.toUpperCase() === 'ACTIVE').length
    const plans = contracts.reduce((total, contract) => total + contract.ratePlans.length, 0)
    return (
      <div className="supplier-page">
        <PageHeader eyebrow="Read only" title="Contracts and rate plans" description="Contracts held for your organization. Rates, amounts, creating a contract and activating a plan are not available, and nothing on this page can be changed." />
        <SummaryStrip items={[
          { label: 'Contracts on this page', value: String(contracts.length), hint: nextCursor ? 'More on the next page' : 'End of list', icon: BookOpenCheck, tone: 'blue' },
          { label: 'Active', value: String(active), hint: 'On this page', icon: CircleCheck, tone: 'green' },
          { label: 'Rate plans shown', value: String(plans), hint: 'On this page', icon: Tags, tone: 'amber' },
        ]} />
        <section className="panel">
          {contracts.length === 0 ? (
            <EmptyState icon={BookOpenCheck} title={cursor ? 'No more contracts' : 'No contracts yet'}>{cursor ? 'You have reached the end of the list.' : 'Contracts appear here once they are held for your organization.'}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table"><caption className="sr-only">Contracts and rate plans</caption>
                <thead><tr><th>Contract</th><th>Hotel</th><th>Term</th><th>Status</th><th>Rate plans</th></tr></thead>
                <tbody>
                  {contracts.map((contract) => (
                    <tr key={contract.id}>
                      <td><strong className="code">{contract.code}</strong><small>Settles in {contract.settlementCurrency}</small></td>
                      <td>{contract.hotelName ?? 'Not linked to a hotel'}</td>
                      <td className="nowrap">{contract.validFrom} <span className="muted">to</span> {contract.validTo}</td>
                      <td><StatusBadge raw={contract.status}>{contract.status}</StatusBadge></td>
                      <td>
                        {contract.ratePlans.length === 0 && <span className="muted">None</span>}
                        <ul className="plan-chips">
                          {contract.ratePlans.map((plan) => (
                            <li key={plan.id} title={`${plan.roomTypeName} · ${plan.boardBasis} · ${plan.status}`}>
                              <b>{plan.code}</b><span>{plan.roomTypeName}</span><span>{plan.boardBasis}</span>
                              <span className={plan.refundable ? 'chip-ok' : 'chip-warn'}>{plan.refundable ? 'Refundable' : 'Non-refundable'}</span>
                            </li>
                          ))}
                        </ul>
                        {contract.ratePlansTruncated && <small>Showing the first {contract.ratePlans.length} plans only.</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager shown={contracts.length} noun="contracts" firstHref={cursor ? '/contracts' : null} nextHref={nextCursor ? `/contracts?cursor=${encodeURIComponent(nextCursor)}` : null} />
        </section>
      </div>
    )
  } catch {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Contracts" description="Contracts could not be loaded. No substitute data is shown." />
  }
}
