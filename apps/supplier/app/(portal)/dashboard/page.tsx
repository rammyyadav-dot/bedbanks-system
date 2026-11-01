import Link from 'next/link'
import { ArrowRight, BadgePercent, BarChart3, BookOpenCheck, Boxes, Building2, CalendarDays, Lock, LockKeyhole, ReceiptText, ShieldCheck, Tags, type LucideIcon } from 'lucide-react'
import { loadPortal } from '../../../lib/portal'

interface Capability {
  href: string
  title: string
  description: string
  permission: string
  icon: LucideIcon
  tone?: 'red' | 'teal'
}

const capabilities: Capability[] = [
  { href: '/hotels', title: 'Properties', description: 'Review the hotels mapped to your organization, check content and mapping status, and keep a private note on each room.', permission: 'supplier.extranet.hotels.read', icon: Building2 },
  { href: '/contracts', title: 'Contracts', description: 'Read the contracts attached to your organization and see the terms your hotels are sold under.', permission: 'supplier.extranet.contracts.read', icon: BookOpenCheck, tone: 'teal' },
  { href: '/bookings', title: 'Bookings', description: 'See the reservations placed on your contracted inventory and where each one stands. Read only.', permission: 'supplier.extranet.bookings.read', icon: Boxes, tone: 'red' },
]

const unavailable: { label: string; icon: LucideIcon }[] = [
  { label: 'Rates', icon: Tags },
  { label: 'Availability', icon: CalendarDays },
  { label: 'Promotions', icon: BadgePercent },
  { label: 'Invoices', icon: ReceiptText },
  { label: 'Reports', icon: BarChart3 },
]

export default async function DashboardPage() {
  const portal = await loadPortal()
  if (portal.kind !== 'ready') return null
  const name = portal.user.name || portal.user.email
  const organization = portal.organization

  if (!organization) {
    return (
      <div className="supplier-page">
        <section className="welcome-hero">
          <div>
            <p className="hero-kicker">Supplier extranet</p>
            <h1>No supplier organization</h1>
            <p>Signed in as {name}. This account has no active supplier-organization membership, so no hotels are shown. Ask your fabBeds account manager to add you to your organization.</p>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="supplier-page">
      <section className="welcome-hero" aria-labelledby="welcome-title">
        <div>
          <p className="hero-kicker">Welcome back{portal.user.name ? `, ${portal.user.name}` : ''}</p>
          <h1 id="welcome-title">{organization.displayName}</h1>
          <p>Review your mapped hotels, contracts and bookings in one place. Publication, answering bookings and settlement are not available yet.</p>
        </div>
        {portal.permissions.includes('supplier.extranet.hotels.read') && (
          <Link className="btn" href="/hotels">View hotels <ArrowRight size={16} aria-hidden="true" /></Link>
        )}
      </section>

      <div className="section-title">
        <h2>Your workspace</h2>
        <p>What you can do today with your membership</p>
      </div>
      <div className="capability-grid">
        {capabilities.map((item) => {
          const Icon = item.icon
          const allowed = portal.permissions.includes(item.permission)
          const className = `capability-card${item.tone ? ` is-${item.tone}` : ''}${allowed ? '' : ' is-locked'}`
          const body = (
            <>
              <span className="capability-icon">{allowed ? <Icon size={22} aria-hidden="true" /> : <LockKeyhole size={22} aria-hidden="true" />}</span>
              <h3>{item.title}</h3>
              <p>{allowed ? item.description : 'Your membership does not include access to this area. Ask an organization admin if you need it.'}</p>
              {allowed && <span className="card-link">Open {item.title.toLowerCase()} <ArrowRight size={15} aria-hidden="true" /></span>}
            </>
          )
          return allowed
            ? <Link key={item.href} href={item.href} className={className}>{body}</Link>
            : <div key={item.href} className={className}>{body}</div>
        })}
      </div>

      <div className="section-title">
        <h2>Not available yet</h2>
        <p>These areas are not connected. Nothing is created, saved or published from them.</p>
      </div>
      <ul className="unavailable-list">
        {unavailable.map((item) => {
          const Icon = item.icon
          return <li key={item.label}><Icon size={18} aria-hidden="true" />{item.label}<small><Lock size={11} aria-hidden="true" /> Unavailable</small></li>
        })}
      </ul>

      <div className="trust-strip">
        <span><ShieldCheck size={17} aria-hidden="true" />Your organization is verified by the server on every request</span>
        <span><ShieldCheck size={17} aria-hidden="true" />Nothing on this site changes a booking, a rate or your stock</span>
      </div>
    </div>
  )
}
