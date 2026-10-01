import Link from 'next/link'
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
        <Link className="back-link" href={`/hotels/${result.hotelId}`}>Back to hotel</Link>
        <PageHeader eyebrow="Private draft" title={result.hotelName} description="A private note is stored for your organization only. It does not change the room, rates, availability, or publication." />
        <section className="panel">
          <div style={{ display: 'grid', gap: 18, padding: 18 }}>
            {result.rooms.length === 0 && <p>No rooms are recorded for this hotel.</p>}
            {result.rooms.map((room) => (
              <article key={room.id}>
                <h2 style={{ margin: 0 }}>{room.name}</h2>
                <p style={{ margin: '6px 0 0', color: '#4b5563' }}>{room.code} · {room.maxAdults} adults · {room.maxOccupancy} occupancy</p>
                <RoomDraftForm hotelId={result.hotelId} roomId={room.id} initialNotes={room.draft?.supplierNotes ?? ''} canEdit={canEdit} />
              </article>
            ))}
          </div>
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 404) notFound()
    return <SupplyWorkflowUnavailable eyebrow="Rooms" title="Rooms unavailable" description="The room list could not be loaded. No substitute rooms are shown." />
  }
}
