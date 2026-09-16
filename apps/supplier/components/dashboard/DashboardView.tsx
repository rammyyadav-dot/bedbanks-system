import Link from 'next/link'
import { AlertTriangle, ArrowRight, Building2, CalendarCheck, ClipboardList, Plus, RefreshCw } from 'lucide-react'
import type { SupplierDashboard } from '../../lib/types'
import { formatMoney } from '../../lib/format'
import { PageHeader } from '../ui/PageHeader'
import { StatusBadge } from '../ui/StatusBadge'

export function DashboardView({ data }: { data: SupplierDashboard }) {
  return (
    <div className="supplier-page dashboard-page">
      <PageHeader
        eyebrow="Meridian Hospitality Group · 16 September 2026"
        title="Good evening, Aisha"
        description="Monitor content readiness, inventory coverage and booking actions across your supply portfolio."
        actions={<><button className="btn"><RefreshCw size={13} /> Refresh</button><Link className="btn btn-primary" href="/properties/new"><Plus size={13} /> Add property</Link></>}
      />

      <section className="onboarding-strip" aria-label="Onboarding progress">
        <div className="progress-orb"><strong>86%</strong><span>complete</span></div>
        <div className="onboarding-copy"><p>SUPPLIER ONBOARDING</p><h2>Complete your finance verification</h2><span>Business profile, contracting and inventory are ready. Add the final settlement documents to complete activation.</span></div>
        <ol>
          <li className="done"><i>1</i><span><strong>Profile</strong><small>Verified</small></span></li>
          <li className="done"><i>2</i><span><strong>Properties</strong><small>12 added</small></span></li>
          <li className="done"><i>3</i><span><strong>Contracts</strong><small>18 active</small></span></li>
          <li className="current"><i>4</i><span><strong>Finance</strong><small>Action due</small></span></li>
        </ol>
        <Link className="btn btn-dark" href="/finance">Continue setup <ArrowRight size={13} /></Link>
      </section>

      <section className="metric-grid" aria-label="Portfolio overview">
        {data.metrics.map((metric, index) => (
          <article className="metric-card" key={metric.label}>
            <span className={`metric-icon tone-${index % 4}`}><MetricIcon index={index} /></span>
            <div><p>{metric.label}</p><strong>{metric.value}</strong><small>{metric.detail}</small></div>
          </article>
        ))}
      </section>

      <div className="dashboard-grid">
        <section className="panel inventory-panel">
          <div className="panel-header"><div><p>90-DAY OUTLOOK</p><h2>Inventory coverage</h2></div><Link href="/availability-inventory">Open calendar <ArrowRight size={12} /></Link></div>
          <div className="inventory-chart" aria-label="Inventory coverage bars">
            {[78, 84, 92, 88, 95, 97, 91, 86, 94, 96, 89, 93, 98, 90].map((value, index) => <span key={index}><i style={{ height: `${value}%` }} className={value < 85 ? 'warning' : ''} /><small>{index % 2 === 0 ? `${index + 17} Sep` : ''}</small></span>)}
          </div>
          <div className="chart-legend"><span><i className="green" /> Available</span><span><i className="orange" /> Coverage gap</span><b>Average 93.4%</b></div>
        </section>

        <section className="panel attention-panel">
          <div className="panel-header"><div><p>WORK QUEUE</p><h2>Needs your attention</h2></div><StatusBadge tone="danger">7 open</StatusBadge></div>
          <div className="alert-list">
            {data.alerts.map((alert) => (
              <article key={alert.id}><span className={`alert-symbol ${alert.tone}`}><AlertTriangle size={14} /></span><div><strong>{alert.title}</strong><small>{alert.detail}</small></div><time>{alert.time}</time></article>
            ))}
          </div>
          <Link className="panel-footer-link" href="/support">View all actions <ArrowRight size={12} /></Link>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header"><div><p>RECENT ACTIVITY</p><h2>Latest bookings</h2></div><Link href="/bookings">View all bookings <ArrowRight size={12} /></Link></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Booking</th><th>Property</th><th>Stay</th><th>Room / board</th><th>Supplier payable</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{data.bookings.map((booking) => <tr key={booking.id}><td><Link href={`/bookings/${booking.id}`}>{booking.id}</Link></td><td><strong>{booking.property}</strong></td><td>{booking.arrival}<small>to {booking.departure}</small></td><td>{booking.room}</td><td><strong>{formatMoney(booking.payableMinor, booking.currency)}</strong></td><td><StatusBadge>{booking.status}</StatusBadge></td><td><button className="row-action" aria-label={`View ${booking.id}`}><ArrowRight size={14} /></button></td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function MetricIcon({ index }: { index: number }) {
  const icons = [Building2, ClipboardList, CalendarCheck, ClipboardList, CalendarCheck, AlertTriangle]
  const Icon = icons[index] ?? Building2
  return <Icon size={15} />
}
