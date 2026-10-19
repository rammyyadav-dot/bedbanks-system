import Link from 'next/link'
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
    return (
      <div className="supplier-page">
        <PageHeader eyebrow="Read only" title="Contracts and rate plans" description="Contracts held for your organization. Rates, amounts, creating a contract, and activating a plan are unavailable here and nothing on this page can be changed." />
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table"><caption className="sr-only">Contracts and rate plans</caption>
              <thead><tr><th>Contract</th><th>Hotel</th><th>Term</th><th>Status</th><th>Rate plans</th></tr></thead>
              <tbody>
                {contracts.length === 0 && <tr><td colSpan={5}>No contracts for this organization.</td></tr>}
                {contracts.map((contract) => (
                  <tr key={contract.id}>
                    <td>{contract.code}<small>{contract.settlementCurrency}</small></td>
                    <td>{contract.hotelName ?? 'Not linked to a hotel'}</td>
                    <td>{contract.validFrom} to {contract.validTo}</td>
                    <td>{contract.status}</td>
                    <td>
                      {contract.ratePlans.length === 0 && 'None'}
                      {contract.ratePlansTruncated && <small style={{ display: 'block' }}>Showing the first {contract.ratePlans.length} plans only.</small>}
                      {contract.ratePlans.map((plan) => (
                        <small key={plan.id} style={{ display: 'block' }}>
                          {plan.code} · {plan.roomTypeName} · {plan.boardBasis} · {plan.refundable ? 'Refundable' : 'Non-refundable'} · {plan.status}
                        </small>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(nextCursor || cursor) && (
            <p style={{ padding: 16, display: 'flex', gap: 8 }}>
              {cursor && <Link className="btn" href="/contracts">First page</Link>}
              {nextCursor && <Link className="btn" href={`/contracts?cursor=${encodeURIComponent(nextCursor)}`}>Next page</Link>}
            </p>
          )}
        </section>
      </div>
    )
  } catch {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Contracts" description="Contracts could not be loaded. No substitute data is shown." />
  }
}
