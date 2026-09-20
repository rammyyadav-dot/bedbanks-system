'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, CalendarDays, CheckCircle2, ChevronDown, RefreshCw, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react'
import { getDashboard } from '@/lib/data'
import { ApiResponseError } from '@/lib/api/errors'
import { AccessDenied, AdminLoadingState, AdminServiceUnavailable, AuthRequired, PermissionUnavailable } from '@/components/auth/AuthorizationStates'
import type { AdminDashboardView, DateRange, DashboardLoadState, HealthState } from '@/lib/types/dashboard'

const ranges: { value: DateRange; label: string }[] = [{ value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }, { value: '90d', label: 'Last 90 days' }]

function money(value: { amount: number; currency: string } | null) { return value ? new Intl.NumberFormat('en-US', { style: 'currency', currency: value.currency, maximumFractionDigits: 0 }).format(value.amount) : '—' }
function healthLabel(value: HealthState | null) { return value ? value[0].toUpperCase() + value.slice(1) : 'Not available' }
function relativeTime(timestamp: string) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)); if (seconds < 60) return 'just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; return `${Math.floor(seconds / 3600)}h ago` }

function Empty({ children }: { children: string }) { return <div className="dashboard-empty">{children}</div> }
function ErrorState({ onRetry }: { onRetry: () => void }) { return <div className="dashboard-error"><AlertCircle size={18} /><div><strong>Dashboard data unavailable</strong><p>We couldn&apos;t load the latest operational data.</p><button type="button" onClick={onRetry}>Retry</button></div></div> }
function Metric({ label, value }: { label: string; value: string }) { return <article className="dashboard-metric"><div className="dashboard-metric-label">{label}</div><strong>{value}</strong><div className="dashboard-metric-change">Awaiting API data</div></article> }

export default function DashboardPage() {
  const [range, setRange] = useState<DateRange>('7d')
  const [data, setData] = useState<AdminDashboardView | null>(null)
  const [state, setState] = useState<DashboardLoadState>('idle')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState('loading'); setError(null)
    try { setData(await getDashboard({ range })); setState('success') } catch (cause) { setData(null); setError(cause instanceof ApiResponseError ? (cause.status === 401 ? 'UNAUTHENTICATED' : cause.status === 403 ? 'FORBIDDEN' : cause.code) : 'UNEXPECTED_ERROR'); setState('error') }
  }, [range])
  useEffect(() => { void load() }, [load])

  const summary = data?.summary
  const activityMax = useMemo(() => Math.max(...(data?.bookingActivity.map((point) => point.total) ?? [0]), 1), [data])
  const refreshLabel = state === 'loading' ? 'Refreshing…' : state === 'success' ? 'Updated' : 'Refresh'

  if (state === 'loading' && !data) return <main className="dashboard-page"><AdminLoadingState /></main>
  if (state === 'error' && error?.includes('FORBIDDEN')) return <main className="dashboard-page"><AccessDenied permission="dashboard.read" /></main>
  if (state === 'error' && error?.includes('UNAUTHENTICATED')) return <main className="dashboard-page"><AuthRequired /></main>
  if (state === 'error' && error?.includes('PERMISSION_UNAVAILABLE')) return <main className="dashboard-page"><PermissionUnavailable onRetry={() => void load()} /></main>
  if (state === 'error' && error?.includes('NETWORK_ERROR')) return <main className="dashboard-page"><AdminServiceUnavailable network onRetry={() => void load()} /></main>
  if (state === 'error' && error?.includes('API_')) return <main className="dashboard-page"><AdminServiceUnavailable onRetry={() => void load()} /></main>

  return <main className="dashboard-page">
    <div className="dashboard-heading"><div><div className="dashboard-eyebrow"><Activity size={12} /> OPERATIONAL OVERVIEW</div><h1>Dashboard</h1><p>Authoritative operational data for your bedbank network.</p></div><div className="dashboard-heading-actions"><label className="dashboard-date-button"><CalendarDays size={15} /><select aria-label="Dashboard date range" value={range} onChange={(event) => setRange(event.target.value as DateRange)}>{ranges.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><ChevronDown size={14} /></label><button className="dashboard-refresh" type="button" onClick={() => void load()} disabled={state === 'loading'}><RefreshCw size={14} className={state === 'loading' ? 'spin' : ''} /> {refreshLabel}</button></div></div>
    {state === 'error' ? <ErrorState onRetry={() => void load()} /> : null}
    <div className="dashboard-freshness">{data ? <>Last updated {relativeTime(data.generatedAt)} · {new Date(data.generatedAt).toLocaleString()}</> : 'Live metrics will appear when the Admin API is connected.'}</div>
    <div className="dashboard-metrics"><Metric label="Total bookings" value={summary ? summary.totalBookings?.toLocaleString() ?? '—' : '—'} /><Metric label="Gross booking value" value={money(summary?.grossBookingValue ?? null)} /><Metric label="Net revenue" value={money(summary?.netRevenue ?? null)} /><Metric label="Active suppliers" value={summary?.activeSuppliers?.toLocaleString() ?? '—'} /><Metric label="Active hotels" value={summary?.activeHotels?.toLocaleString() ?? '—'} /><Metric label="System health" value={healthLabel(summary?.systemHealth ?? null)} /></div>
    <div className="dashboard-main-grid"><section className="dashboard-panel chart-panel"><div className="dashboard-panel-header"><div><h2>Booking activity</h2><p>Bookings over the selected period</p></div></div>{data?.bookingActivity.length ? <div className="dashboard-bars" role="img" aria-label="Booking activity chart"><div className="dashboard-bar-area">{data.bookingActivity.map((point) => <div className="dashboard-bar-column" key={point.date}><div className="dashboard-bar total" style={{ height: `${point.total / activityMax * 100}%` }} title={`${point.total} bookings`} /><div className="dashboard-bar confirmed" style={{ height: `${point.confirmed / activityMax * 100}%` }} title={`${point.confirmed} confirmed`} /><small>{point.date}</small></div>)}</div></div> : <Empty>No booking activity available for this period.</Empty>}</section><section className="dashboard-panel"><div className="dashboard-panel-header"><div><h2>Revenue overview</h2><p>Gross and net revenue with explicit currency</p></div></div>{data?.revenueOverview.length ? <div className="dashboard-list">{data.revenueOverview.map((point) => <div className="dashboard-list-row" key={point.date}><span>{point.date}</span><strong>{money(point.gross)}</strong><strong>{money(point.net)}</strong></div>)}</div> : <Empty>No revenue data available.</Empty>}</section><section className="dashboard-panel health-panel"><div className="dashboard-panel-header"><div><h2>System health</h2><p>Reported by connected services</p></div><ShieldCheck size={18} /></div>{data?.systemHealth.length ? <div className="health-list">{data.systemHealth.map((item) => <div className="health-row" key={item.name}><span className="health-icon">{item.state === 'healthy' ? <CheckCircle2 size={14} /> : item.state === 'down' ? <XCircle size={14} /> : <TriangleAlert size={14} />}</span><span>{item.name}</span><strong className={`health-${item.state}`}>{healthLabel(item.state)}</strong></div>)}</div> : <Empty>No service health data available.</Empty>}</section></div>
    <div className="dashboard-lower-grid"><section className="dashboard-panel bookings-panel"><div className="dashboard-panel-header"><div><h2>Recent bookings</h2><p>Latest reservation activity</p></div></div>{data?.recentBookings.length ? <div className="dashboard-table-wrap"><table className="dashboard-table"><caption className="sr-only">Recent bookings</caption><thead><tr><th>Reference</th><th>Agency</th><th>Hotel</th><th>Status</th><th>Amount</th></tr></thead><tbody>{data.recentBookings.map((booking) => <tr key={booking.id}><td className="strong-cell">{booking.reference}</td><td>{booking.agency}</td><td>{booking.hotel}</td><td>{booking.status}</td><td>{money(booking.amount)}</td></tr>)}</tbody></table></div> : <Empty>No bookings found for this period.</Empty>}</section><aside className="dashboard-panel alerts-panel"><div className="dashboard-panel-header"><div><h2>Alerts &amp; notifications</h2><p>Items requiring attention</p></div></div>{data?.alerts.length ? data.alerts.map((alert) => <div className="alert-row" key={alert.id}><span className={`alert-icon ${alert.severity.toLowerCase()}`} aria-label={alert.severity}><AlertCircle size={15} /></span><span><strong>{alert.title}</strong><small>{alert.detail}</small></span><time dateTime={alert.createdAt}>{relativeTime(alert.createdAt)}</time></div>) : <Empty>No alerts.</Empty>}</aside></div>
    <div className="dashboard-mini-grid"><section className="dashboard-panel ranking-panel"><div className="dashboard-panel-header"><div><h2>Top destinations</h2><p>Provided by the Admin API</p></div></div>{data?.topDestinations.length ? data.topDestinations.map((item) => <div className="ranking-row" key={item.name}><span>{item.name}</span><strong>{item.bookings.toLocaleString()}</strong><small>{item.share}%</small></div>) : <Empty>No destination data available.</Empty>}</section><section className="dashboard-panel ranking-panel"><div className="dashboard-panel-header"><div><h2>Top suppliers</h2><p>Provided by the Admin API</p></div></div>{data?.topSuppliers.length ? data.topSuppliers.map((item) => <div className="ranking-row" key={item.name}><span>{item.name}</span><strong>{item.bookings.toLocaleString()}</strong><small>{item.share}%</small></div>) : <Empty>No supplier activity available.</Empty>}</section></div>
    {error ? <p className="dashboard-error-detail">{error}</p> : null}
  </main>
}
