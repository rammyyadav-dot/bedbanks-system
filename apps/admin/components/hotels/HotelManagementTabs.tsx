'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { useCan } from '@/lib/auth/capabilities'
import { HOTEL_TABS, hotelHref, type HotelTabId } from '@/lib/hotel-ui'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getDealSummary } from '@/lib/data/hotel-deals'

type ManagementTab = { label: string; tab?: HotelTabId; view?: string; href?: string; unavailable?: string; secondary?: boolean }

export function HotelManagementTabs({ data, tab, visibleTabs }: { data: HotelCommercial360; tab: HotelTabId; visibleTabs: ReadonlyArray<(typeof HOTEL_TABS)[number]> }) {
  const can = useCan()
  const view = useSearchParams().get('view')
  const counts = data.rooms.reduce((sum, room) => sum + room.ratePlans.total, 0)
  // The number of deals that apply today, from the API. While it loads, or if it fails, the tab shows no number rather than a made-up one.
  const deals = useOpsQuery(() => getDealSummary({ hotelId: data.hotel.id }), [data.hotel.id])
  const liveDeals = deals.state.status === 'ready' ? deals.state.data.byStatus.ACTIVE : null
  const primary: ManagementTab[] = [
    { label: 'Hotel Setup', tab: 'overview' },
    { label: `Room Types (${data.rooms.length})`, tab: 'rooms' },
    { label: `Rate Plans (${counts})`, tab: 'rateplans' },
    { label: liveDeals === null ? 'Deals & Promos' : `Deals & Promos (${liveDeals})`, tab: 'rateplans', view: 'promotions' },
    { label: 'Rate Grid', tab: 'rates', view: 'grid', unavailable: can('supply.rates.manage') ? undefined : 'Editing the rate grid requires rate management permission.' },
    { label: 'Event Master', href: can('supply.room_events.read') ? '/room-events' : undefined, unavailable: can('supply.room_events.read') ? undefined : 'Event Master requires room event read permission.' },
    { label: 'Meal Plans', href: can('supply.rates.read') ? '/board-basis' : undefined, unavailable: can('supply.rates.read') ? undefined : 'Meal plans require rate read permission.' },
    { label: 'Blackout Dates', tab: 'quick' },
    { label: 'Allocation Mgmt', tab: 'inventory', secondary: true },
    { label: 'Room Availability', tab: 'inventory', view: 'availability', secondary: true },
    { label: 'Rate Calendar', tab: 'rates', secondary: true },
  ]
  const primaryTabs = primary.filter(item => !item.tab || visibleTabs.some(t => t.id === item.tab))
  const more = visibleTabs.filter(t => !primary.some(item => item.tab === t.id) && t.id !== 'setup')
  function href(item: ManagementTab) {
    if (item.href) return item.href
    const base = item.tab === 'overview' ? `/hotels/${encodeURIComponent(data.hotel.id)}?tab=overview` : hotelHref(data.hotel.id, item.tab)
    return `${base}${item.view ? `&view=${item.view}` : ''}`
  }
  return <>
    <nav className="hotel-management-tabs" aria-label="Hotel management sections">
      {[false, true].map(secondary => <div className="hotel-management-tab-row" key={String(secondary)}>{primaryTabs.filter(item => !!item.secondary === secondary).map(item => {
        const active = item.tab === 'overview' ? tab === 'overview' || tab === 'setup' : item.tab === tab && (item.view ? item.view === view : !view || !primary.some(t => t.tab === tab && t.view === view))
        return item.unavailable ? <span className="hotel-management-tab-unavailable" key={item.label} role="link" aria-disabled="true" tabIndex={0} title={item.unavailable} aria-label={`${item.label}. ${item.unavailable}`}>{item.label}</span> : <Link key={item.label} id={`hotel-tab-${item.tab}${item.view ? `-${item.view}` : ''}`} href={href(item)} replace={!!item.tab} scroll={false} aria-current={active ? 'page' : undefined} className={active ? 'active' : undefined}>{item.label}</Link>
      })}</div>)}
    </nav>
    {more.length > 0 && <details className="hotel-more-tools" open={more.some(item => item.id === tab)}><summary>More hotel tools</summary><nav aria-label="Additional hotel tools">{more.map(item => <Link key={item.id} id={`hotel-tab-${item.id}`} href={hotelHref(data.hotel.id, item.id)} replace scroll={false} aria-current={item.id === tab ? 'page' : undefined}>{item.label}</Link>)}</nav></details>}
  </>
}
