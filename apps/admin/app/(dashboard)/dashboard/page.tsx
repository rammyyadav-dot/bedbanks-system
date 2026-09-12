import { Building2, Users, Hotel, Truck, CalendarRange, DollarSign, Clock, AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { KPI } from '@/components/dashboard/KPI'
import { KPIGrid } from '@/components/dashboard/KPIGrid'
import { ChartCard } from '@/components/dashboard/ChartCard'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { HealthCard } from '@/components/dashboard/HealthCard'
import { getDashboardKpis, getSystemStatus, getSuppliers, getHotels } from '@/lib/data'

export default async function DashboardPage() {
  const [kpis, status, suppliers, hotels] = await Promise.all([
    getDashboardKpis(), getSystemStatus(), getSuppliers(), getHotels(),
  ])

  const destinationCounts = Object.entries(
    hotels.reduce<Record<string, number>>((acc, h) => { acc[h.destination] = (acc[h.destination] ?? 0) + 1; return acc }, {}),
  ).map(([label, value]) => ({ label, value }))

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="OPERATIONAL OVERVIEW"
        title="Dashboard"
        description="Live snapshot of tenants, hotel supply, distribution, and financial health across FBEDS."
      />

      <KPIGrid>
        <KPI label="Active Tenants" value={String(kpis.activeTenants)} icon={Building2} tone="cyan" />
        <KPI label="Active Agents" value={String(kpis.activeAgents)} icon={Users} tone="blue" />
        <KPI label="Hotels" value={kpis.hotels.toLocaleString()} icon={Hotel} tone="green" />
        <KPI label="Suppliers" value={String(kpis.suppliers)} icon={Truck} tone="cyan" />
      </KPIGrid>
      <KPIGrid>
        <KPI label="Bookings Today" value={String(kpis.bookingsToday)} icon={CalendarRange} tone="blue" />
        <KPI label="Revenue Today" value={`$${kpis.revenueToday.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} icon={DollarSign} tone="green" />
        <KPI label="Pending Bookings" value={String(kpis.pendingBookings)} icon={Clock} tone="amber" />
        <KPI label="Supplier Errors" value={String(kpis.supplierErrors)} icon={AlertTriangle} tone="amber" />
      </KPIGrid>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <ChartCard title="Booking Volume" subtitle="Last 7 days, mock data" bars={[{ label: 'Mon', value: 42 }, { label: 'Tue', value: 55 }, { label: 'Wed', value: 38 }, { label: 'Thu', value: 61 }, { label: 'Fri', value: 74 }, { label: 'Sat', value: 88 }, { label: 'Sun', value: 52 }]} />
        <ChartCard title="Revenue Trend" subtitle="USD, last 7 days, mock data" bars={[{ label: 'Mon', value: 18400 }, { label: 'Tue', value: 21200 }, { label: 'Wed', value: 16800 }, { label: 'Thu', value: 24900 }, { label: 'Fri', value: 31200 }, { label: 'Sat', value: 35800 }, { label: 'Sun', value: 22100 }]} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <ChartCard title="Top Destinations" subtitle="Hotels by destination" bars={destinationCounts} />
        <div className="panel">
          <div className="panel-header"><h2>Supplier Health</h2></div>
          <div style={{ padding: '0 18px 16px' }}>
            {suppliers.map((s) => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid #edf2f3', fontSize: 11 }}>
                <span style={{ color: '#2c4a55', fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: '#8ba0a5' }}>{s.successRate}% success</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <ActivityFeed items={[
          { id: '1', text: 'Jordan Davis viewed tenant directory', time: '2 min ago' },
          { id: '2', text: 'New booking FB260909000201 confirmed', time: '18 min ago' },
          { id: '3', text: 'Supplier "Regional DMC" sync failed', time: '54 min ago' },
          { id: '4', text: 'Maya Chen updated a membership role', time: '1h ago' },
        ]} />
        <HealthCard items={status} />
      </div>
    </div>
  )
}
