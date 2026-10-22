import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '../../../../components/ui/PageHeader'
import { SupplyWorkflowUnavailable } from '../../../../components/supply/SupplyWorkflowUnavailable'
import { getHotel, SupplierApiError } from '../../../../lib/supplier-api'
import { loadPortal } from '../../../../lib/portal'

export default async function HotelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready' || !portal.organization) return null
  if (!portal.permissions.includes('supplier.extranet.hotels.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Hotel" title="Hotel unavailable" description="This membership cannot read hotels." />
  }
  const { id } = await params
  try {
    const hotel = await getHotel(id)
    return (
      <div className="supplier-page">
        <Link className="back-link" href="/hotels">Back to hotels</Link>
        <PageHeader eyebrow={`${hotel.city}, ${hotel.countryCode}`} title={hotel.name} description="This is the mapped hotel record. Profile edits, photos, and publication are unavailable." actions={<Link className="btn btn-primary" href={`/hotels/${hotel.id}/rooms`}>View rooms</Link>} />
        <section className="panel">
          <div className="form-section">
            <dl className="detail-list">
              <div><dt>Property type</dt><dd>{hotel.propertyType}</dd></div>
              <div><dt>Content status</dt><dd>{hotel.contentStatus}</dd></div>
              <div><dt>Mapping</dt><dd>{hotel.mappingStatus}</dd></div>
              <div><dt>City</dt><dd>{hotel.city}</dd></div>
            </dl>
          </div>
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 404) notFound()
    return <SupplyWorkflowUnavailable eyebrow="Hotel" title="Hotel unavailable" description="The hotel could not be loaded. No substitute property is shown." />
  }
}
