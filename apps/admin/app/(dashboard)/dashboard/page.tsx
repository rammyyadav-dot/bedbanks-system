'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, Bell, CalendarDays,
  CheckCircle2, ChevronDown, CircleDollarSign, Database, Hotel, PackageCheck, RefreshCw,
  Search, ShieldCheck, ShoppingBag, TrendingUp, Users, WalletCards, XCircle,
} from 'lucide-react'
import { getBookings, getDashboardKpis } from '@/lib/data'
import type { Booking } from '@/lib/types/admin'

type DashboardData = Awaited<ReturnType<typeof getDashboardKpis>>

const trend = [68, 82, 76, 96, 88, 74, 98]
const revenue = [58, 64, 71, 74, 79, 91, 100]
const destinations = [
  ['Dubai, UAE', '2,482', '19.9%'], ['Bangkok, Thailand', '1,876', '15.0%'],
  ['London, UK', '1,542', '12.4%'], ['Singapore, Singapore', '1,203', '9.6%'], ['New York, USA', '982', '7.9%'],
]

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

function Metric({ label, value, change, icon: Icon, tone, down = false }: { label: string; value: string; change: string; icon: typeof Activity; tone: string; down?: boolean }) {
  return <article className="dashboard-metric"><div className={`dashboard-metric-icon ${tone}`}><Icon size={17} /></div><div className="dashboard-metric-label">{label}</div><strong>{value}</strong><div className={`dashboard-metric-change ${down ? 'down' : ''}`}>{down ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}{change}<span>vs. last 7 days</span></div></article>
}

function TrendChart({ values, color, secondary = false }: { values: number[]; color: string; secondary?: boolean }) {
  const points = values.map((value, index) => `${index * 16.66},${108 - value}`).join(' ')
  return <div className="dashboard-chart"><div className="dashboard-y-axis"><span>2,000</span><span>1,500</span><span>1,000</span><span>500</span><span>0</span></div><svg viewBox="0 0 100 110" preserveAspectRatio="none"><defs><linearGradient id={`area-${secondary ? 'revenue' : 'bookings'}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".18" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs><path d={`M 0 108 L ${points} L 100 108 Z`} fill={`url(#area-${secondary ? 'revenue' : 'bookings'})`} /><polyline points={points} fill="none" stroke={color} strokeWidth="2.4" vectorEffect="non-scaling-stroke" /></svg><div className="dashboard-x-axis"><span>Apr 23</span><span>Apr 24</span><span>Apr 25</span><span>Apr 26</span><span>Apr 27</span><span>Apr 28</span><span>Apr 29</span></div></div>
}

function RecentBookings({ bookings }: { bookings: Booking[] }) {
  return <section className="dashboard-panel bookings-panel"><div className="dashboard-panel-header"><div><h2>Recent bookings</h2><p>Latest reservation activity across your network</p></div><button className="dashboard-link" type="button">View all</button></div><div className="dashboard-table-wrap"><table className="dashboard-table"><thead><tr><th>Booking ID</th><th>Agency</th><th>Hotel</th><th>Check-in</th><th>Check-out</th><th>Status</th><th>Amount</th></tr></thead><tbody>{bookings.map((booking) => <tr key={booking.id}><td className="strong-cell">{booking.reference.slice(-6)}</td><td>{booking.tenant}</td><td>{booking.hotel}</td><td>{booking.checkIn}</td><td>{booking.checkOut}</td><td><span className={`dashboard-status ${booking.status}`}>{booking.status}</span></td><td>{formatAmount(booking.amount, booking.currency)}</td></tr>)}</tbody></table></div></section>
}

export default function DashboardPage() {
  const [range, setRange] = useState('Apr 23, 2025 – Apr 29, 2025')
  const [search, setSearch] = useState('')
  const [refreshed, setRefreshed] = useState(false)
  const [data, setData] = useState<DashboardData | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])

  useEffect(() => { Promise.all([getDashboardKpis(), getBookings()]).then(([kpis, nextBookings]) => { setData(kpis); setBookings(nextBookings) }) }, [])

  const filteredBookings = useMemo(() => bookings.filter((booking) => [booking.reference, booking.tenant, booking.hotel].join(' ').toLowerCase().includes(search.toLowerCase())), [bookings, search])
  const kpis = data ?? { activeTenants: 0, activeAgents: 0, hotels: 0, suppliers: 0, bookingsToday: 0, revenueToday: 0, pendingBookings: 0, supplierErrors: 0 }

  return <div className="dashboard-page">
    <div className="dashboard-heading"><div><div className="dashboard-eyebrow"><Activity size={12} /> OPERATIONAL OVERVIEW</div><h1>Dashboard</h1><p>Welcome back, Rammy. Here&apos;s what&apos;s happening with your bedbank operations.</p></div><div className="dashboard-heading-actions"><button className="dashboard-date-button" type="button" onClick={() => setRange(range.includes('2025') ? 'Last 7 days' : 'Apr 23, 2025 – Apr 29, 2025')}><CalendarDays size={15} /> {range}<ChevronDown size={14} /></button><button className="dashboard-refresh" type="button" onClick={() => { setRefreshed(true); setTimeout(() => setRefreshed(false), 1600) }}><RefreshCw size={14} className={refreshed ? 'spin' : ''} /> Refresh</button></div></div>
    <div className="dashboard-metrics"><Metric label="Total bookings" value="12,482" change="12.5%" icon={CalendarDays} tone="blue" /><Metric label="Today&apos;s bookings" value={String(kpis.bookingsToday)} change="8.3%" icon={ShoppingBag} tone="cyan" /><Metric label="Active hotels" value={kpis.hotels.toLocaleString()} change="5.2%" icon={Hotel} tone="blue" /><Metric label="Active suppliers" value={String(kpis.suppliers)} change="3.8%" icon={Users} tone="green" /><Metric label="Gross booking value" value="$4,892,340" change="14.7%" icon={CircleDollarSign} tone="blue" /><Metric label="Net revenue" value={formatAmount(kpis.revenueToday, 'USD')} change="11.2%" icon={TrendingUp} tone="green" /><Metric label="Pending actions" value={String(kpis.pendingBookings)} change="33.3%" icon={AlertCircle} tone="red" down /><Metric label="System health" value="Healthy" change="99.8% uptime" icon={ShieldCheck} tone="green" /></div>
    <div className="dashboard-main-grid"><section className="dashboard-panel chart-panel"><div className="dashboard-panel-header"><div><h2>Booking activity</h2><p>Bookings by day</p></div><div className="dashboard-legend"><span><i className="red-dot" /> Total bookings</span><span><i className="blue-dot" /> Confirmed</span></div></div><TrendChart values={trend} color="#e31837" /></section><section className="dashboard-panel chart-panel"><div className="dashboard-panel-header"><div><h2>Revenue overview</h2><p>Gross vs net revenue</p></div><div className="dashboard-legend"><span><i className="red-dot square" /> Gross booking value</span><span><i className="blue-dot square" /> Net revenue</span></div></div><div className="revenue-bars">{revenue.map((value, index) => <div className="revenue-bar-group" key={index}><div className="revenue-bar gross" style={{ height: `${value}%` }} /><div className="revenue-bar net" style={{ height: `${value * .72}%` }} /><small>Apr {23 + index}</small></div>)}</div></section><section className="dashboard-panel health-panel"><div className="dashboard-panel-header"><div><h2>System health</h2><p>Live service status</p></div><button className="dashboard-link" type="button">View all</button></div><div className="health-list">{['Supplier API', 'Inventory sync', 'Rate sync', 'Booking engine', 'Database'].map((item) => <div className="health-row" key={item}><span className="health-icon"><Database size={14} /></span><span>{item}</span><strong><CheckCircle2 size={13} /> Healthy</strong></div>)}</div></section></div>
    <div className="dashboard-lower-grid"><div><RecentBookings bookings={filteredBookings} /><div className="dashboard-mini-grid"><section className="dashboard-panel ranking-panel"><div className="dashboard-panel-header"><div><h2>Top destinations</h2><p>By bookings</p></div><button className="dashboard-link" type="button">View all</button></div>{destinations.map(([name, count, share], index) => <div className="ranking-row" key={name}><b>{index + 1}</b><span className="flag-dot">{['🇦🇪', '🇹🇭', '🇬🇧', '🇸🇬', '🇺🇸'][index]}</span><span>{name}</span><i><em style={{ width: `${100 - index * 15}%` }} /></i><small>{count}</small><small>{share}</small></div>)}</section><section className="dashboard-panel ranking-panel"><div className="dashboard-panel-header"><div><h2>Top suppliers</h2><p>By bookings</p></div><button className="dashboard-link" type="button">View all</button></div>{['Expedia', 'Booking.com', 'TUI Travel', 'HRS', 'Direct'].map((name, index) => <div className="ranking-row" key={name}><b>{index + 1}</b><span className="supplier-logo">{name.slice(0, 1)}</span><span>{name}</span><i><em style={{ width: `${100 - index * 14}%` }} /></i><small>{['2,948', '2,412', '1,876', '1,542', '1,203'][index]}</small><small>{['23.6%', '19.3%', '15.0%', '12.4%', '9.6%'][index]}</small></div>)}</section></div></div><section className="dashboard-panel alerts-panel"><div className="dashboard-panel-header"><div><h2>Alerts &amp; notifications</h2><p>Items requiring attention</p></div><button className="dashboard-link" type="button">View all</button></div>{[['Supplier sync failed', 'SunHotels API — last sync 2 hours ago', 'danger', XCircle], ['Rate mismatch detected', 'Grand Plaza Hotel — rate variance > 10%', 'warning', AlertCircle], ['Contract expiring', 'Beach Resort — expires in 7 days', 'warning', PackageCheck], ['Inventory unavailable', 'City Central Hotel — no rooms available', 'danger', Bell], ['Payment overdue', 'TUI Travel — $12,450.00', 'danger', WalletCards]].map(([title, detail, tone, Icon]) => <div className="alert-row" key={title as string}><span className={`alert-icon ${tone}`}><Icon size={15} /></span><span><strong>{title as string}</strong><small>{detail as string}</small></span><time>{title === 'Supplier sync failed' ? '2h ago' : title === 'Rate mismatch detected' ? '4h ago' : title === 'Contract expiring' ? '6h ago' : title === 'Inventory unavailable' ? '8h ago' : '12h ago'}</time></div>)}</section></div>
    <div className="dashboard-search-overlay"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter recent bookings by hotel, agency, or ID..." aria-label="Filter recent bookings" /></div>
  </div>
}
