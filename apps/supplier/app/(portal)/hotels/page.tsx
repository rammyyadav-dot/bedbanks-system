import Link from 'next/link'
import { PageHeader } from '../../../components/ui/PageHeader'
import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'
import { listHotels, SupplierApiError } from '../../../lib/supplier-api'
import { loadPortal } from '../../../lib/portal'

export default async function HotelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready') return null
  if (!portal.organization) {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Hotels" description="No supplier organization is available for this account." />
  }
  if (!portal.permissions.includes('supplier.extranet.hotels.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Hotels" description="This membership cannot read hotels." />
  }
  try {
    const raw = (await searchParams).cursor
    const cursor = typeof raw === 'string' && raw.length > 0 && raw.length <= 700 ? raw : undefined
    const { hotels, nextCursor } = await listHotels({ cursor, limit: 25 })
    return (
      <div className="supplier-page">
        <PageHeader eyebrow="Mapped hotels" title="Hotels" description="Hotels shown here are mapped to your organization. Adding a hotel, publishing content, and opening inventory are unavailable." />
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table"><caption className="sr-only">Mapped hotels</caption>
              <thead><tr><th>Hotel</th><th>Location</th><th>Content status</th><th>Mapping</th></tr></thead>
              <tbody>
                {hotels.length === 0 && <tr><td colSpan={4}>{cursor ? 'No more hotels.' : 'No mapped hotels.'}</td></tr>}
                {hotels.map((hotel) => (
                  <tr key={hotel.id}>
                    <td><Link href={`/hotels/${hotel.id}`}>{hotel.name}</Link><small>{hotel.propertyType}</small></td>
                    <td>{hotel.city}, {hotel.countryCode}</td>
                    <td>{hotel.contentStatus}</td>
                    <td>{hotel.mappingStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(nextCursor || cursor) && (
            <p style={{ padding: 16, display: 'flex', gap: 8 }}>
              {cursor && <Link className="btn" href="/hotels">First page</Link>}
              {nextCursor && <Link className="btn" href={`/hotels?cursor=${encodeURIComponent(nextCursor)}`}>Next page</Link>}
            </p>
          )}
        </section>
      </div>
    )
  } catch (error) {
    const status = error instanceof SupplierApiError ? error.status : 0
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Hotels unavailable" description={status === 403 ? 'Hotel access was denied for this organization.' : 'The hotel list could not be loaded. No substitute hotels are shown.'} />
  }
}
