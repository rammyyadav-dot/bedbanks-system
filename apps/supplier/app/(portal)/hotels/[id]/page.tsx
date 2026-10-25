import Link from 'next/link'
import { ArrowLeft, MapPin } from 'lucide-react'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { initialsOf } from '../../../../lib/status'
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
        <Link className="back-link" href="/hotels"><ArrowLeft size={15} aria-hidden="true" />Back to properties</Link>
        <PageHeader eyebrow={`${hotel.city}, ${hotel.countryCode}`} title={hotel.name} description="This is the mapped hotel record. Profile edits, photos, and publication are unavailable." actions={<Link className="btn btn-primary" href={`/hotels/${hotel.id}/rooms`}>View rooms</Link>} />
        <section className="panel">
          <div className="detail-hero">
            <span aria-hidden="true">{initialsOf(hotel.name)}</span>
            <div><p className="page-eyebrow is-muted">{hotel.propertyType}</p><h2>Property record</h2><p><MapPin size={14} aria-hidden="true" />{hotel.city}, {hotel.countryCode}</p></div>
          </div>
          <dl className="detail-list detail-list-bordered">
            <div><dt>Property type</dt><dd>{hotel.propertyType}</dd></div>
            <div><dt>City</dt><dd>{hotel.city}</dd></div>
            <div><dt>Content status</dt><dd><StatusBadge raw={hotel.contentStatus}>{hotel.contentStatus}</StatusBadge></dd></div>
            <div><dt>Mapping</dt><dd><StatusBadge raw={hotel.mappingStatus}>{hotel.mappingStatus}</StatusBadge></dd></div>
          </dl>
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 404) notFound()
    return <SupplyWorkflowUnavailable eyebrow="Hotel" title="Hotel unavailable" description="The hotel could not be loaded. No substitute property is shown." />
  }
}
