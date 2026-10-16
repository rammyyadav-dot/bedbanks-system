'use client'

import Link from 'next/link'
import { Building2, ChevronRight, Plus } from 'lucide-react'
import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { HotelManagementSummary } from '@/components/hotels/HotelManagementSummary'
import { HotelManagementTabs } from '@/components/hotels/HotelManagementTabs'
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
import { RateGrid } from '@/components/hotels/panels/RateGrid'
import { RatesInventoryPanel } from '@/components/hotels/panels/RatesInventoryPanel'
import { DistributionPanel } from '@/components/hotels/panels/DistributionPanel'
import { BookingsPanel } from '@/components/hotels/panels/BookingsPanel'
import { AuditPanel } from '@/components/hotels/panels/AuditPanel'
import { HotelHeaderMetadata } from '@/components/hotels/HotelHeaderMetadata'
import { ReportsPanel } from '@/components/hotels/panels/ReportsPanel'
import { useCan } from '@/lib/auth/capabilities'
import { getHotel360 } from '@/lib/data/hotel-commercial'
import { hotelLifecycleLabel, HOTEL_TABS, hotelHref, parseTab, starsText, type HotelTabId } from '@/lib/hotel-ui'

const TAB_PERMISSION: Partial<Record<HotelTabId, 'supply.contracts.read' | 'supply.mappings.read' | 'supply.rates.read' | 'supply.availability.read' | 'supply.rooms.read' | 'booking.read' | 'audit.read'>> = {
  rooms: 'supply.rooms.read', mappings: 'supply.mappings.read', contracts: 'supply.contracts.read', rateplans: 'supply.rates.read', rates: 'supply.rates.read', sellability: 'supply.rates.read', inventory: 'supply.availability.read', bookings: 'booking.read', audit: 'audit.read', reports: 'booking.read',
}

function Hotel360({ id }: { id: string }) {
  const params = useSearchParams()
  const tab = parseTab(params.get('tab'))
  const propertySetup = !params.has('tab')
  const can = useCan()
  const { state, reload, refresh } = useOpsQuery(() => getHotel360(id), [id])
  const visibleTabs = HOTEL_TABS.filter((t) => { if (t.id === 'quick') return can('supply.rates.read') && (can('supply.rates.manage') || can('supply.availability.manage')); const permission = TAB_PERMISSION[t.id]; return !permission || can(permission) })


  return (
    <div className={`admin-page ${propertySetup ? '' : 'hotel-management-page'}`}>
      <OpsState state={state} onRetry={reload}>
        {(data) => propertySetup && can('supply.rooms.read') ? (
          <section className="hotel-property-setup" aria-label="Property Setup">
            <div className="hotel-property-heading"><h1>Property Setup</h1><div className="hotel-property-actions">
              <Link className="hotel-ui-button" href={hotelHref(id, 'setup')}><Building2 size={13} />Hotel Profile</Link>
              {can('supply.hotels.manage') && <Link className="hotel-ui-button hotel-ui-green" href="/hotels/new"><Plus size={13} />Add &amp; Create New Hotel</Link>}
              {can('supply.rooms.manage') && <Link className="hotel-ui-button hotel-ui-purple" href={`${hotelHref(id, 'rooms')}&room=new`}><Plus size={13} />Add Room Type</Link>}
            </div></div>
            <div className="hotel-selected-property"><span>Selected Hotel:</span><span className="hotel-selected-chip"><Building2 size={13} />{data.hotel.name}</span><em>(Change via the Property selector in the header)</em></div>
            <RoomsPanel data={data} onChanged={refresh} compact />
            <div className="hotel-management-link"><Link className="hotel-ui-button" href={`/hotels/${encodeURIComponent(id)}?tab=overview`}>Full Hotel Management<ChevronRight size={13} /></Link></div>
          </section>
        ) : (
          <>
            <div className="hotel-management-heading"><div><h1>{data.hotel.name}</h1><p>{data.hotel.city}, {data.hotel.countryCode} · {starsText(data.hotel.starRating)}<span className={`hotel-profile-status ${data.hotel.contentStatus.toLowerCase()}`}>{hotelLifecycleLabel(data.hotel.contentStatus)}</span></p></div><Link href="/hotels" className="hotel-ui-button">All hotels</Link></div>
            <HotelManagementSummary data={data} onRefresh={refresh} />
            <HotelManagementTabs data={data} tab={tab} visibleTabs={visibleTabs} />
            <div role="tabpanel" id="hotel-panel" aria-label={HOTEL_TABS.find(item => item.id === tab)?.label} key={`${tab}-${params.get('view') ?? ''}`} style={{ marginTop: 12 }}>
              {tab === 'overview' && <OverviewPanel data={data} onChanged={refresh} />}
              {tab === 'setup' && <SetupPanel hotelId={id} onChanged={refresh} />}
              {tab === 'rooms' && <RoomsPanel data={data} onChanged={refresh} />}
              {tab === 'amenities' && <AmenitiesPanel hotelId={id} onChanged={refresh} />}
              {tab === 'images' && <ImagesPanel hotelId={id} />}
              {tab === 'policies' && <PoliciesPanel hotelId={id} onChanged={refresh} />}
              {tab === 'mappings' && <MappingsPanel hotelId={id} />}
              {tab === 'contracts' && <ContractsPanel hotelId={id} gates={data.gates} />}
              {tab === 'rateplans' && <>{params.get('view') === 'promotions' && <p className="hotel-summary-note">Choose a rate plan below to manage its deals and promotions.</p>}<RatePlansPanel hotelId={id} rooms={data.rooms} /></>}
              {tab === 'rates' && (params.get('view') === 'grid' && can('supply.rates.manage') ? <RateGrid hotelId={id} onApplied={refresh} /> : <RatesInventoryPanel hotelId={id} rooms={data.rooms} />)}
              {tab === 'inventory' && <InventoryPanel hotelId={id} rooms={data.rooms} />}
              {tab === 'quick' && <QuickUpdatePanel hotelId={id} data={data} onChanged={refresh} />}
              {tab === 'sellability' && <DistributionPanel hotelId={id} rooms={data.rooms} />}
              {tab === 'bookings' && <BookingsPanel hotelId={id} />}
              {tab === 'reports' && <ReportsPanel hotelId={id} />}
              {tab === 'audit' && <AuditPanel hotelId={id} />}
            </div>
            <details className="hotel-management-details"><summary>Property details</summary>
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
            </details>
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
