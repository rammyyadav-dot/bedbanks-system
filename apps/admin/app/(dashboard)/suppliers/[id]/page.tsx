import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { HealthBadge } from '@/components/status/HealthBadge'
import { Tabs } from '@/components/common/Tabs'
import { StatCard } from '@/components/common/StatCard'
import { getSupplier } from '@/lib/data'

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supplier = await getSupplier(id)
  if (!supplier) notFound()

  return (
    <div className="admin-page">
      <PageHeader eyebrow={`SUPPLIER · ${supplier.type}`} title={supplier.name} description={`Last synced ${new Date(supplier.lastSync).toLocaleString()}`} actions={<HealthBadge state={supplier.connection} />} />
      <div className="admin-summary-cards">
        <StatCard label="Hotels Mapped" value={supplier.hotels.toLocaleString()} />
        <StatCard label="Success Rate" value={`${supplier.successRate}%`} />
        <StatCard label="Connection Type" value={supplier.type} />
        <StatCard label="Status" value={supplier.status} />
      </div>
      <Tabs tabs={[
        { id: 'overview', label: 'Overview', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Supplier relationship overview — mock summary.</div> },
        { id: 'connection', label: 'Connection', content: (
          <div className="workspace-panel" style={{ padding: 18, fontSize: 12 }}>
            <div style={{ marginBottom: 10 }}>API Key</div>
            <div className="admin-masked">••••••••••••••••</div>
          </div>
        ) },
        { id: 'hotel-mapping', label: 'Hotel Mapping', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>{supplier.hotels.toLocaleString()} hotels mapped from this supplier.</div> },
        { id: 'room-mapping', label: 'Room Mapping', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Room-type mapping placeholder.</div> },
        { id: 'contracts', label: 'Contracts', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>See the Contracts module for commercial terms with this supplier.</div> },
        { id: 'search-perf', label: 'Search Performance', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>See Distribution → Search Monitor for live comparisons.</div> },
        { id: 'booking-perf', label: 'Booking Performance', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Booking success/failure trend placeholder.</div> },
        { id: 'errors', label: 'Errors', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>No unresolved supplier errors recorded (mock).</div> },
      ]} />
    </div>
  )
}
