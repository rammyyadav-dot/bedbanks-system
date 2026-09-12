import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/status/StatusBadge'
import { Tabs } from '@/components/common/Tabs'
import { StatCard } from '@/components/common/StatCard'
import { getHotel, getRoomsByHotel } from '@/lib/data'

export default async function HotelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const hotel = await getHotel(id)
  if (!hotel) notFound()
  const rooms = await getRoomsByHotel(hotel.id)

  return (
    <div className="admin-page">
      <PageHeader eyebrow={`HOTEL · ${hotel.code}`} title={hotel.name} description={`${hotel.destination}, ${hotel.country} · ${'★'.repeat(hotel.stars)}`} actions={<StatusBadge status={hotel.status} />} />
      <div className="admin-summary-cards">
        <StatCard label="Supplier" value={hotel.supplier} />
        <StatCard label="Stars" value={String(hotel.stars)} />
        <StatCard label="Rooms Mapped" value={String(rooms.length)} />
        <StatCard label="Updated" value={hotel.updatedAt} />
      </div>
      <Tabs tabs={[
        { id: 'overview', label: 'Overview', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Hotel master overview — mock summary.</div> },
        { id: 'rooms', label: 'Rooms', content: (
          <div className="workspace-panel">
            {rooms.length === 0 && <div style={{ padding: 20, fontSize: 12, color: '#7c949a' }}>No rooms mapped yet.</div>}
            {rooms.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '1px solid #edf2f3', fontSize: 12 }}>
                <span>{r.type} <span style={{ color: '#8ba0a5' }}>· {r.occupancy}</span></span>
                <span style={{ color: '#8ba0a5' }}>{r.mealPlan}</span>
              </div>
            ))}
          </div>
        ) },
        { id: 'amenities', label: 'Amenities', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Pool, Spa, Free Wi-Fi, Airport Shuttle, Fitness Centre — mock amenities.</div> },
        { id: 'images', label: 'Images', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Image gallery placeholder.</div> },
        { id: 'policies', label: 'Policies', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Standard cancellation policy: free cancellation up to 48h before check-in (mock).</div> },
        { id: 'mapping', label: 'Supplier Mapping', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Mapped to <strong>{hotel.supplier}</strong> as hotel code <strong>{hotel.code}</strong>.</div> },
        { id: 'rates', label: 'Rates', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>See the Rates module for live pricing across suppliers.</div> },
        { id: 'inventory', label: 'Inventory', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>See the Inventory module for allotment and stop-sell status.</div> },
        { id: 'audit', label: 'Audit', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>No audit events recorded for this hotel yet.</div> },
      ]} />
    </div>
  )
}
