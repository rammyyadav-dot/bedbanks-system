import Link from 'next/link'
import { Building2, ChevronRight, MapPinCheck, MapPinOff } from 'lucide-react'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Pager } from '../../../components/ui/Pager'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import { SummaryStrip } from '../../../components/ui/SummaryStrip'
import { initialsOf } from '../../../lib/status'
import { PageHeader } from '../../../components/ui/PageHeader'
import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'
import { listHotels, SupplierApiError } from '../../../lib/supplier-api'
import { loadPortal } from '../../../lib/portal'

export default async function HotelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready') return null
  if (!portal.organization) {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Properties" description="No supplier organization is available for this account." />
  }
  if (!portal.permissions.includes('supplier.extranet.hotels.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Properties" description="This membership cannot read hotels." />
  }
  try {
    const raw = (await searchParams).cursor
    const cursor = typeof raw === 'string' && raw.length > 0 && raw.length <= 700 ? raw : undefined
    const { hotels, nextCursor } = await listHotels({ cursor, limit: 25 })
    const mapped = hotels.filter((hotel) => hotel.mappingStatus.toUpperCase() === 'MAPPED').length
    return (
      <div className="supplier-page">
        <PageHeader eyebrow="Mapped hotels" title="Properties" description="Hotels mapped to your organization. Adding a hotel, publishing content and opening inventory are not available." />
        <SummaryStrip items={[
          { label: 'Hotels on this page', value: String(hotels.length), hint: nextCursor ? 'More on the next page' : 'End of list', icon: Building2, tone: 'blue' },
          { label: 'Mapped', value: String(mapped), hint: 'On this page', icon: MapPinCheck, tone: 'green' },
          { label: 'Not mapped', value: String(hotels.length - mapped), hint: 'On this page', icon: MapPinOff, tone: 'amber' },
        ]} />
        <section className="panel">
          {hotels.length === 0 ? (
            <EmptyState icon={Building2} title={cursor ? 'No more hotels' : 'No mapped hotels'}>{cursor ? 'You have reached the end of the list.' : 'Hotels appear here once they are mapped to your organization.'}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table"><caption className="sr-only">Mapped hotels</caption>
                <thead><tr><th>Hotel</th><th>Location</th><th>Content</th><th>Mapping</th><th><span className="sr-only">Open</span></th></tr></thead>
                <tbody>
                  {hotels.map((hotel) => (
                    <tr key={hotel.id}>
                      <td><div className="property-cell"><span aria-hidden="true">{initialsOf(hotel.name)}</span><div><Link href={`/hotels/${hotel.id}`}>{hotel.name}</Link><small>{hotel.propertyType}</small></div></div></td>
                      <td>{hotel.city}, {hotel.countryCode}</td>
                      <td><StatusBadge raw={hotel.contentStatus}>{hotel.contentStatus}</StatusBadge></td>
                      <td><StatusBadge raw={hotel.mappingStatus}>{hotel.mappingStatus}</StatusBadge></td>
                      <td className="row-end"><Link className="row-link" href={`/hotels/${hotel.id}`} aria-label={`Open ${hotel.name}`}><ChevronRight size={18} aria-hidden="true" /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager shown={hotels.length} noun="hotels" firstHref={cursor ? '/hotels' : null} nextHref={nextCursor ? `/hotels?cursor=${encodeURIComponent(nextCursor)}` : null} />
        </section>
      </div>
    )
  } catch (error) {
    const status = error instanceof SupplierApiError ? error.status : 0
    return <SupplyWorkflowUnavailable eyebrow="Portfolio" title="Hotels unavailable" description={status === 403 ? 'Hotel access was denied for this organization.' : 'The hotel list could not be loaded. No substitute hotels are shown.'} />
  }
}
