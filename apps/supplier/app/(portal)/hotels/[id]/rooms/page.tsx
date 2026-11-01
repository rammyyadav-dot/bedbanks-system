import Link from 'next/link'
import { ArrowLeft, BedDouble } from 'lucide-react'
import { EmptyState } from '../../../../../components/ui/EmptyState'
import { notFound } from 'next/navigation'
import { PageHeader } from '../../../../../components/ui/PageHeader'
import { SupplyWorkflowUnavailable } from '../../../../../components/supply/SupplyWorkflowUnavailable'
import { RoomDraftForm } from '../../../../../components/hotels/RoomDraftForm'
import { listRooms, SupplierApiError } from '../../../../../lib/supplier-api'
import { loadPortal } from '../../../../../lib/portal'

export default async function HotelRoomsPage({ params }: { params: Promise<{ id: string }> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready' || !portal.organization) return null
  if (!portal.permissions.includes('supplier.extranet.rooms.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Rooms" title="Rooms unavailable" description="This membership cannot read rooms." />
  }
  const { id } = await params
  const canEdit = portal.permissions.includes('supplier.extranet.drafts.manage')
  try {
    const result = await listRooms(id)
    return (
      <div className="supplier-page">
        <Link className="back-link" href={`/hotels/${result.hotelId}`}><ArrowLeft size={15} aria-hidden="true" />Back to hotel</Link>
        <PageHeader eyebrow="Private draft" title={result.hotelName} description="A private note is stored for your organization only. It does not change the room, rates, availability, or publication." />
        {result.rooms.length === 0 && <section className="panel"><EmptyState icon={BedDouble} title="No rooms recorded">No rooms are recorded for this hotel.</EmptyState></section>}
        <div className="room-list">
          {result.rooms.map((room) => (
            <article key={room.id} className="panel room-card">
              <header>
                <span className="capability-icon"><BedDouble size={20} aria-hidden="true" /></span>
                <div><h2>{room.name}</h2><p>{room.code}</p></div>
                <ul className="plan-chips"><li><span>{room.maxAdults} {room.maxAdults === 1 ? 'adult' : 'adults'}</span><span>{room.maxChildren} {room.maxChildren === 1 ? 'child' : 'children'}</span><span>Max {room.maxOccupancy}</span></li></ul>
              </header>
              <RoomDraftForm hotelId={result.hotelId} roomId={room.id} initialNotes={room.draft?.supplierNotes ?? ''} canEdit={canEdit} />
            </article>
          ))}
        </div>
      </div>
    )
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 404) notFound()
    return <SupplyWorkflowUnavailable eyebrow="Rooms" title="Rooms unavailable" description="The room list could not be loaded. No substitute rooms are shown." />
  }
}
