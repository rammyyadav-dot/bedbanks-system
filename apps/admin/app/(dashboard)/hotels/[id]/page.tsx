'use client'

import Link from 'next/link'
import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingState } from '@/components/common/LoadingState'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Chip, ContractChip, MappingChip, ReadinessChip } from '@/components/hotels/ui'
import { OverviewPanel } from '@/components/hotels/panels/OverviewPanel'
import { SetupPanel } from '@/components/hotels/panels/SetupPanel'
import { RoomsPanel } from '@/components/hotels/panels/RoomsPanel'
import { AmenitiesPanel } from '@/components/hotels/panels/AmenitiesPanel'
import { ImagesPanel } from '@/components/hotels/panels/ImagesPanel'
import { PoliciesPanel } from '@/components/hotels/panels/PoliciesPanel'
import { QuickUpdatePanel } from '@/components/hotels/panels/QuickUpdatePanel'
import { MappingsPanel } from '@/components/hotels/panels/MappingsPanel'
import { ContractsPanel } from '@/components/hotels/panels/ContractsPanel'
import { InventoryPanel } from '@/components/hotels/panels/InventoryPanel'
import { RatePlansPanel } from '@/components/hotels/panels/RatePlansPanel'
import { RatesInventoryPanel } from '@/components/hotels/panels/RatesInventoryPanel'
import { DistributionPanel } from '@/components/hotels/panels/DistributionPanel'
import { BookingsPanel } from '@/components/hotels/panels/BookingsPanel'
import { AuditPanel } from '@/components/hotels/panels/AuditPanel'
import { HotelHeaderMetadata } from '@/components/hotels/HotelHeaderMetadata'
import { ReportsPanel } from '@/components/hotels/panels/ReportsPanel'
import { useCan } from '@/lib/auth/capabilities'
import { getHotel360 } from '@/lib/data/hotel-commercial'
import { HOTEL_WORKSPACE_SECTIONS, workspaceSection, HOTEL_TABS, hotelHref, parseTab, starsText, type HotelTabId } from '@/lib/hotel-ui'

const TAB_PERMISSION: Partial<Record<HotelTabId, 'supply.contracts.read' | 'supply.mappings.read' | 'supply.rates.read' | 'supply.availability.read' | 'supply.rooms.read' | 'booking.read' | 'audit.read'>> = {
  rooms: 'supply.rooms.read', mappings: 'supply.mappings.read', contracts: 'supply.contracts.read', rateplans: 'supply.rates.read', rates: 'supply.rates.read', sellability: 'supply.rates.read', inventory: 'supply.availability.read', bookings: 'booking.read', audit: 'audit.read', reports: 'booking.read',
}

function Hotel360({ id }: { id: string }) {
  const tab = parseTab(useSearchParams().get('tab'))
  const can = useCan()
  const { state, reload, refresh } = useOpsQuery(() => getHotel360(id), [id])
  const visibleTabs = HOTEL_TABS.filter((t) => { if (t.id === 'quick') return can('supply.rates.read') && (can('supply.rates.manage') || can('supply.availability.manage')); const permission = TAB_PERMISSION[t.id]; return !permission || can(permission) })

  const section = workspaceSection(tab)
  const visibleSections = HOTEL_WORKSPACE_SECTIONS.map(s => ({ ...s, available: visibleTabs.filter(t => (s.tabs as readonly string[]).includes(t.id)) })).filter(s => s.available.length > 0)

  return (
    <div className="admin-page">
      <OpsState state={state} onRetry={reload}>
        {(data) => (
          <>
            <PageHeader eyebrow={`HOTEL · ${data.hotel.code ?? data.hotel.id}`} title={data.hotel.name} description={`${data.hotel.city}, ${data.hotel.countryCode} · ${data.hotel.propertyType} · ${starsText(data.hotel.starRating)}`} actions={<Link href="/hotels" className="admin-btn">All hotels</Link>} />
            <dl data-testid="hotel-header" className="hotel-facts" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 16px', margin: '0 0 12px' }}>
              <div><dt>Commercial readiness</dt><dd><ReadinessChip value={data.readiness} blockers={data.blockers} /></dd></div>
              <div><dt>Supply coverage (buyer-independent)</dt><dd><Chip tone={data.agentSellable ? 'ok' : 'bad'}>{data.agentSellable ? 'YES' : 'NO'}</Chip></dd></div>
              <div><dt>Supplier</dt><dd>{data.suppliers.length ? data.suppliers.map((s) => s.displayName).join(', ') : '—'}</dd></div>
              <div><dt>Hotel mapping</dt><dd><MappingChip value={data.hotelMapping} /></dd></div>
              <div><dt>Contract</dt><dd><ContractChip value={data.contractState} /></dd></div>
              <div><dt>Hotel code</dt><dd>{data.hotel.code ?? '—'}</dd></div>
              <div><dt>Canonical ID</dt><dd><code>{data.hotel.id}</code></dd></div>
              <div><dt>Room types</dt><dd>{data.rooms.length}</dd></div>
              <HotelHeaderMetadata hotelId={id} updatedAt={data.hotel.updatedAt} contentStatus={data.hotel.contentStatus} />
              <div><dt>Bookings / active holds</dt><dd>{data.counts.bookings ?? 'unavailable'} / {data.counts.activeHolds ?? 'unavailable'}</dd></div>
            </dl>
            <p style={{ color: '#3f565c', fontSize: 11, margin: '0 0 8px' }}>Assessed {data.window.from} → {data.window.to} ({data.window.days} nights).</p>
            <nav aria-label="Hotel sections">
              <div className="admin-tabs" role="tablist">
                {visibleSections.map((s) => (
                  <Link key={s.id} role="tab" id={`section-${s.id}`} aria-selected={section.id === s.id} aria-controls="hotel-panel" tabIndex={section.id === s.id ? 0 : -1} onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    const links = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLAnchorElement>('[role="tab"]'))
                    const index = links.indexOf(event.currentTarget)
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length
                    event.preventDefault(); links[next]?.focus()
                  }} href={hotelHref(id, s.available.some(t => t.id === s.defaultTab) ? s.defaultTab : s.available[0]!.id)} replace scroll={false} className={`admin-tab ${section.id === s.id ? 'active' : ''}`}>{s.label}</Link>
                ))}
              </div>
            </nav>
            {section.tabs.length > 1 && <nav aria-label={`${section.label} sections`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {visibleTabs.filter(t => (section.tabs as readonly string[]).includes(t.id)).map(t => <Link key={t.id} href={hotelHref(id, t.id)} replace scroll={false} aria-current={tab === t.id ? 'page' : undefined} className={`admin-btn ${tab === t.id ? 'primary' : ''}`}>{t.label}</Link>)}
            </nav>}

            <div role="tabpanel" id="hotel-panel" aria-labelledby={`section-${section.id}`} key={tab} style={{ marginTop: 12 }}>
              {tab === 'overview' && <OverviewPanel data={data} onChanged={refresh} />}
              {tab === 'setup' && <SetupPanel hotelId={id} onChanged={refresh} />}
              {tab === 'rooms' && <RoomsPanel data={data} onChanged={refresh} />}
              {tab === 'amenities' && <AmenitiesPanel hotelId={id} onChanged={refresh} />}
              {tab === 'images' && <ImagesPanel hotelId={id} />}
              {tab === 'policies' && <PoliciesPanel hotelId={id} onChanged={refresh} />}
              {tab === 'mappings' && <MappingsPanel hotelId={id} />}
              {tab === 'contracts' && <ContractsPanel hotelId={id} gates={data.gates} />}
              {tab === 'rateplans' && <RatePlansPanel hotelId={id} rooms={data.rooms} />}
              {tab === 'rates' && <RatesInventoryPanel hotelId={id} rooms={data.rooms} />}
              {tab === 'inventory' && <InventoryPanel hotelId={id} rooms={data.rooms} />}
              {tab === 'quick' && <QuickUpdatePanel hotelId={id} data={data} onChanged={refresh} />}
              {tab === 'sellability' && <DistributionPanel hotelId={id} rooms={data.rooms} />}
              {tab === 'bookings' && <BookingsPanel hotelId={id} />}
              {tab === 'reports' && <ReportsPanel hotelId={id} />}
              {tab === 'audit' && <AuditPanel hotelId={id} />}
            </div>
          </>
        )}
      </OpsState>
    </div>
  )
}

function HotelWorkspace() {
  const { id } = useParams<{ id: string }>()
  // Remount before paint: no previous hotel data, drafts or pending responses survive a hotel switch.
  return <Hotel360 key={id} id={id} />
}
export default function HotelDetailPage() { return <Suspense fallback={<LoadingState rows={6} />}><HotelWorkspace /></Suspense> }
