'use client'

import { useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpRight,
  BedDouble,
  Bell,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Database,
  FileCode2,
  Gauge,
  Hotel,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Users,
  WalletCards,
  X,
} from 'lucide-react'

const hotels = [
  { id: 'H-1042', name: 'The Hoxton, Shoreditch', city: 'London, UK', stars: 5, rate: 184.2, suppliers: 3, rooms: '12 room types', status: 'Instant confirm', accent: 'cyan' },
  { id: 'H-2981', name: 'CitizenM Tower of London', city: 'London, UK', stars: 4, rate: 126.8, suppliers: 2, rooms: '8 room types', status: 'Instant confirm', accent: 'blue' },
  { id: 'H-7730', name: 'Hotel Arts Barcelona', city: 'Barcelona, ES', stars: 5, rate: 242.5, suppliers: 4, rooms: '16 room types', status: 'On request', accent: 'amber' },
  { id: 'H-5518', name: 'Moxy Berlin Ostbahnhof', city: 'Berlin, DE', stars: 4, rate: 98.4, suppliers: 2, rooms: '6 room types', status: 'Instant confirm', accent: 'cyan' },
]

const tenants = [
  { code: 'TRV-001', name: 'Travel Republic', tier: 'Gold', balance: '$184,290', usage: '82%', api: 'Healthy', requests: '42.8k' },
  { code: 'AGT-093', name: 'Atlas Getaways', tier: 'Silver', balance: '$64,820', usage: '61%', api: 'Healthy', requests: '18.4k' },
  { code: 'HLY-442', name: 'Holiday Lines', tier: 'VIP', balance: '$412,500', usage: '34%', api: 'Degraded', requests: '9.2k' },
  { code: 'BOK-718', name: 'Booking Hub EU', tier: 'Bronze', balance: '$12,090', usage: '91%', api: 'Healthy', requests: '4.7k' },
]

const logs = [
  { time: '14:32:08.921', tenant: 'TRV-001', endpoint: '/v2/hotels/search', latency: '842ms', status: 200 },
  { time: '14:32:08.774', tenant: 'AGT-093', endpoint: '/v2/bookings/create', latency: '1.24s', status: 200 },
  { time: '14:32:07.430', tenant: 'HLY-442', endpoint: '/v2/hotels/search', latency: '2.81s', status: 500 },
  { time: '14:32:06.182', tenant: 'BOK-718', endpoint: '/v2/hotels/search', latency: '1.09s', status: 200 },
  { time: '14:32:05.901', tenant: 'TRV-001', endpoint: '/v2/content/hotels', latency: '319ms', status: 200 },
]

const nav = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Hotel Search', icon: Search },
  { label: 'Reservations', icon: BedDouble, count: '128' },
  { label: 'Hotel Content', icon: Building2 },
  { label: 'Tenants & Wallets', icon: Users },
  { label: 'Distribution Hub', icon: Network },
]

function StatusPill({ children, tone = 'success' }: { children: React.ReactNode; tone?: 'success' | 'warning' | 'danger' | 'neutral' }) {
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{children}</span>
}

function MetricCard({ label, value, delta, icon: Icon, tone }: { label: string; value: string; delta: string; icon: typeof Activity; tone: string }) {
  return <div className="metric-card">
    <div className="metric-top"><span className="metric-label">{label}</span><span className={`metric-icon ${tone}`}><Icon size={16} /></span></div>
    <div className="metric-value">{value}</div>
    <div className="metric-delta"><TrendingUp size={13} /> {delta} <span>vs last 24h</span></div>
  </div>
}

function MiniChart() {
  const points = '0,72 28,64 56,68 84,46 112,55 140,31 168,39 196,21 224,28 252,10 280,22 308,5 336,16 364,9 392,18'
  return <div className="mini-chart" aria-label="Search fan-out latency trending under target"><svg viewBox="0 0 392 84" role="img"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".22" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs><path d={`M ${points} L 392,84 L 0,84 Z`} fill="url(#chart-fill)" /><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg><div className="chart-axis"><span>12:00</span><span>14:00</span><span>Now</span></div></div>
}

export function BedbankDashboard() {
  const [activeNav, setActiveNav] = useState('Overview')
  const [expanded, setExpanded] = useState<string | null>('H-1042')
  const [tenantOpen, setTenantOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [query, setQuery] = useState('London')
  const filteredHotels = useMemo(() => hotels.filter((hotel) => hotel.name.toLowerCase().includes(query.toLowerCase()) || hotel.city.toLowerCase().includes(query.toLowerCase()) || !query), [query])

  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(''), 2800) }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Hotel size={18} /></div><div><strong>bedbank</strong><span>CORE OPERATIONS</span></div></div>
      <div className="tenant-switcher" role="button" tabIndex={0} onClick={() => setTenantOpen(!tenantOpen)}><div className="tenant-avatar">A</div><div className="tenant-copy"><span>Workspace</span><strong>Atlas Platform</strong></div><ChevronDown size={15} className={tenantOpen ? 'rotate' : ''} />{tenantOpen && <div className="tenant-menu"><div><span className="tenant-avatar small">A</span>Atlas Platform <ShieldCheck size={13} /></div><div><span className="tenant-avatar small muted">T</span>Travel Republic</div><div><Plus size={14} />Add workspace</div></div>}</div>
      <div className="nav-section"><span className="nav-caption">OPERATIONS</span>{nav.map(({ label, icon: Icon, count }) => <button key={label} className={`nav-item ${activeNav === label ? 'active' : ''}`} onClick={() => setActiveNav(label)}><Icon size={17} /><span>{label}</span>{count && <em>{count}</em>}{label === 'Overview' && <span className="live-pip" />}</button>)}</div>
      <div className="nav-section lower"><span className="nav-caption">PLATFORM</span><button className="nav-item"><FileCode2 size={17} /><span>API Credentials</span></button><button className="nav-item"><Database size={17} /><span>System Logs</span></button><button className="nav-item"><Settings size={17} /><span>Settings</span></button></div>
      <div className="sidebar-bottom"><div className="support-card"><div className="support-icon"><LifeBuoy size={16} /></div><div><strong>Need help?</strong><span>Talk to platform support</span></div><ArrowUpRight size={14} /></div><div className="user-row"><div className="user-avatar">JD</div><div><strong>Jordan Davis</strong><span>Super Admin</span></div><MoreHorizontal size={17} /></div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu"><Menu size={18} /></button><span>Platform</span><ChevronRight size={14} /><strong>{activeNav}</strong></div><div className="top-actions"><span className="environment"><span className="status-dot" />Production</span><button className="icon-button" aria-label="Notifications"><Bell size={17} /><span className="notification-dot" /></button><button className="icon-button" aria-label="Help"><CircleHelp size={17} /></button><div className="top-avatar">JD</div></div></header>
      <div className="content-wrap">
        <section className="page-heading"><div><div className="eyebrow"><span className="live-pip" />SYSTEM OVERVIEW <span className="slash">/</span> 04 SEP 2026, 14:32 UTC</div><h1>Good afternoon, Jordan.</h1><p>Here&apos;s what&apos;s happening across your hotel distribution network.</p></div><div className="heading-actions"><button className="button secondary" onClick={() => notify('Dashboard data refreshed')}><RefreshCw size={15} />Refresh data</button><button className="button primary" onClick={() => notify('Search workspace opened')}><Plus size={15} />New reservation</button></div></section>
        <section className="metric-grid"><MetricCard label="Active tenants" value="248" delta="12.4%" icon={Users} tone="cyan" /><MetricCard label="Global GMV · 24h" value="$2.84M" delta="18.7%" icon={WalletCards} tone="amber" /><MetricCard label="API requests · 24h" value="1.42M" delta="24.1%" icon={Activity} tone="blue" /><MetricCard label="Avg. search latency" value="1,284 ms" delta="8.2%" icon={Gauge} tone="green" /></section>
        <section className="main-grid"><div className="panel search-panel"><div className="panel-header"><div><div className="panel-kicker"><Search size={14} /> LIVE INVENTORY</div><h2>Hotel search & aggregation</h2></div><button className="text-button" onClick={() => setQuery('')}><SlidersHorizontal size={14} />Advanced filters</button></div><div className="search-form"><div className="field destination"><label>DESTINATION / GIATA</label><div className="input-wrap"><Search size={15} /><input aria-label="Destination" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="City or GIATA code" /></div></div><div className="field"><label>CHECK-IN</label><div className="input-wrap"><input aria-label="Check-in" value="18 Sep 2026" readOnly /></div></div><div className="field"><label>CHECK-OUT</label><div className="input-wrap"><input aria-label="Check-out" value="21 Sep 2026" readOnly /></div></div><div className="field rooms"><label>ROOMS & GUESTS</label><button className="select-button">1 room · 2 guests <ChevronDown size={14} /></button></div><button className="button primary search-button" onClick={() => notify(`Searching ${query || 'all destinations'}`)}><Search size={15} />Search</button></div><div className="table-meta"><span><strong>{filteredHotels.length * 24}</strong> properties found across <strong>4 suppliers</strong></span><span className="supplier-legend"><i className="legend-dot hotelbeds" />Hotelbeds <i className="legend-dot webbeds" />WebBeds <i className="legend-dot direct" />Direct</span></div><div className="hotel-table"><div className="table-header"><span>PROPERTY</span><span>SUPPLIERS</span><span>AVAILABILITY</span><span>FROM / NIGHT</span><span /></div>{filteredHotels.map((hotel) => <div className="hotel-group" key={hotel.id}><button className="table-row hotel-row" onClick={() => setExpanded(expanded === hotel.id ? null : hotel.id)}><span className="hotel-name"><span className={`expand-icon ${expanded === hotel.id ? 'open' : ''}`}><ChevronRight size={14} /></span><span><strong>{hotel.name}</strong><small>{hotel.city} · {Array.from({ length: hotel.stars }).map(() => '★').join('')} <b>{hotel.id}</b></small></span></span><span className="supplier-count"><span className="supplier-stack"><i /><i /><i /></span>{hotel.suppliers} sources</span><span><StatusPill tone={hotel.status === 'On request' ? 'warning' : 'success'}>{hotel.status}</StatusPill></span><span className="rate"><strong>${hotel.rate.toFixed(2)}</strong><small>USD / night</small></span><MoreHorizontal size={16} className="row-more" /></button>{expanded === hotel.id && <div className="expanded-row"><div className="expanded-intro"><span className="expand-label">CONNECTED INVENTORY</span><span>Rates normalized · Markup applied for <strong>Atlas Platform</strong></span></div>{[['Hotelbeds','HB-882019','$162.40','Free cancellation'],['WebBeds','WB-104299','$169.80','Free cancellation'],['Direct contract','DC-441209',' $174.00','Non-refundable']].map(([source, ref, price, cancel]) => <div className="source-row" key={source}><span className={`source-badge ${source === 'Hotelbeds' ? 'hb' : source === 'WebBeds' ? 'wb' : 'dc'}`}>{source === 'Hotelbeds' ? 'HB' : source === 'WebBeds' ? 'WB' : 'DC'}</span><span><strong>{source}</strong><small>{ref}</small></span><span>Deluxe King · Room only</span><span><strong>{cancel}</strong><small>until 16 Sep</small></span><span className="rate"><strong>${price}</strong><small>NET MASKED</small></span><button className="book-button" onClick={() => notify(`Booking flow started for ${hotel.name}`)}>Book <ArrowUpRight size={13} /></button></div>)}</div>}</div>)}</div><button className="view-all" onClick={() => notify('All inventory loaded')}>View all inventory <ArrowUpRight size={14} /></button></div><div className="side-stack"><div className="panel telemetry-panel"><div className="panel-header"><div><div className="panel-kicker"><Activity size={14} /> DISTRIBUTION TELEMETRY</div><h2>API performance</h2></div><button className="icon-button"><MoreHorizontal size={17} /></button></div><div className="telemetry-stat"><div><span>Search fan-out latency</span><strong>1,284 <small>ms avg.</small></strong></div><StatusPill>Within target</StatusPill></div><MiniChart /><div className="target-line"><span>Target threshold</span><strong>&lt; 1,800 ms</strong></div><div className="channel-list"><div className="channel-row"><span className="channel-icon xml">&lt;/&gt;</span><span><strong>XML Gateway</strong><small>42 downstream buyers</small></span><StatusPill>Operational</StatusPill></div><div className="channel-row"><span className="channel-icon api">API</span><span><strong>REST API v2</strong><small>186 active clients</small></span><StatusPill>Operational</StatusPill></div><div className="channel-row"><span className="channel-icon webhook">↗</span><span><strong>Webhooks</strong><small>3 deliveries delayed</small></span><StatusPill tone="warning">Degraded</StatusPill></div></div></div><div className="panel activity-panel"><div className="panel-header"><div><div className="panel-kicker"><ArrowDownToLine size={14} /> RECENT ACTIVITY</div><h2>Live request log</h2></div><button className="text-button">Open logs <ArrowUpRight size={13} /></button></div><div className="logs">{logs.map((log) => <div className="log-row" key={`${log.time}-${log.tenant}`}><span className={`log-status ${log.status === 200 ? 'ok' : 'error'}`}>{log.status}</span><span className="log-time">{log.time}</span><span className="log-tenant">{log.tenant}</span><span className="log-endpoint">{log.endpoint}</span><span className="log-latency">{log.latency}</span></div>)}</div></div></div></section>
        <section className="bottom-grid"><div className="panel tenants-panel"><div className="panel-header"><div><div className="panel-kicker"><CreditCard size={14} /> TENANT CONTROL</div><h2>Top B2B agencies</h2></div><button className="text-button" onClick={() => setActiveNav('Tenants & Wallets')}>Manage tenants <ArrowUpRight size={13} /></button></div><div className="tenant-table"><div className="table-header"><span>AGENCY</span><span>TIER</span><span>AVAILABLE BALANCE</span><span>API HEALTH</span><span>24H REQUESTS</span></div>{tenants.map((tenant) => <div className="table-row" key={tenant.code}><span className="agency"><span className="agency-avatar">{tenant.name.slice(0, 1)}</span><span><strong>{tenant.name}</strong><small>{tenant.code}</small></span></span><span><span className={`tier ${tenant.tier.toLowerCase()}`}>{tenant.tier}</span></span><span><strong>{tenant.balance}</strong><small className="usage"><span style={{ width: tenant.usage }} />{tenant.usage} used</small></span><span><StatusPill tone={tenant.api === 'Degraded' ? 'warning' : 'success'}>{tenant.api}</StatusPill></span><span className="requests">{tenant.requests} <ArrowUpRight size={13} /></span></div>)}</div></div><div className="panel alerts-panel"><div className="panel-header"><div><div className="panel-kicker"><AlertTriangle size={14} /> NEEDS ATTENTION</div><h2>System alerts</h2></div><span className="alert-count">3 open</span></div><div className="alert-list"><div className="alert-row"><span className="alert-symbol danger"><AlertTriangle size={14} /></span><span><strong>HLY-442 API latency spike</strong><small>Distribution Hub · 4 min ago</small></span><ChevronRight size={15} /></div><div className="alert-row"><span className="alert-symbol warning"><KeyRound size={14} /></span><span><strong>2 API keys expire soon</strong><small>Tenant Control · 2 hours ago</small></span><ChevronRight size={15} /></div><div className="alert-row"><span className="alert-symbol neutral"><RefreshCw size={14} /></span><span><strong>Supplier content sync delayed</strong><small>Hotelbeds · 5 hours ago</small></span><ChevronRight size={15} /></div></div><button className="view-all" onClick={() => notify('Alerts marked as read')}>Review all alerts <ArrowUpRight size={14} /></button></div></section>
      </div>
    </main>{toast && <div className="toast"><ShieldCheck size={16} />{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={14} /></button></div>}
  </div>
}
