'use client'

import Link from 'next/link'
import { AuthImage } from '@/components/hotels/AuthImage'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CONTRACT_EXPIRING_DAYS, CONTRACT_EXPIRY_FILTER_DAYS, COMMERCIAL_ISSUE_CATEGORIES, HOTEL_PROPERTY_TYPES } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingState } from '@/components/common/LoadingState'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { StatusBadge } from '@/components/status/StatusBadge'
import { ContractChip, InventoryChip, MappingChip, RatesChip, ReadinessChip, ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { HotelsSummary } from '@/components/hotels/HotelsSummary'
import { useCan } from '@/lib/auth/capabilities'
import { getHotelsCommercial, getHotelsSummary } from '@/lib/data/hotel-commercial'
import { getOpsSuppliers } from '@/lib/data/operations'
import { hotelHref, listHref, readListQuery, reasonText, starsText, type ListFilterKey } from '@/lib/hotel-ui'

const PAGE_SIZE = 25
const entityStatus = (value: string) => (value === 'COMPLETE' ? 'active' : value === 'SUSPENDED' ? 'suspended' : 'pending') as 'active' | 'suspended' | 'pending'
const selectStyle = { minWidth: 120 }

function HotelsList() {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams()
  const can = useCan()
  const { filters, page } = useMemo(() => readListQuery(params), [params])
  const [search, setSearch] = useState(filters.search ?? '')
  useEffect(() => setSearch(filters.search ?? ''), [filters.search])
  const go = (next: Partial<Record<ListFilterKey, string>>, nextPage = 1) => router.replace(`${pathname}${listHref(next, nextPage).slice('/hotels'.length)}`, { scroll: false })
  const setFilter = (key: ListFilterKey, value: string) => go({ ...filters, [key]: value || undefined } as never)

  const summary = useOpsQuery(() => getHotelsSummary(), [])
  const list = useOpsQuery(() => getHotelsCommercial({ ...filters, page, pageSize: PAGE_SIZE }), [params.toString()])
  const suppliers = useOpsQuery(() => getOpsSuppliers({ pageSize: 100 }), [])
  const supplierOptions = suppliers.state.status === 'ready' ? suppliers.state.data.items : []
  const destinations = list.state.status === 'ready' ? list.state.data.destinations : []
  const activeFilters = Object.keys(filters).length

  return (
    <div className="admin-page">
      <PageHeader eyebrow="HOTEL SUPPLY · HOTELS" title="Hotels" description="Hotel master data and commercial readiness. Readiness is computed by the API with the same rules Agents are sold by." actions={can('supply.hotels.manage') ? <Link href="/hotels/new" className="button primary">+ Add hotel</Link> : undefined} />
      {summary.state.status === 'ready' && <HotelsSummary summary={summary.state.data} />}
      {summary.state.status === 'failed' && <p role="status" data-testid="summary-unavailable" style={{ color: '#8a5a00', fontSize: 12 }}>Commercial summary unavailable ({summary.state.failure}). The list below is unaffected.</p>}
      <form onSubmit={(event) => { event.preventDefault(); setFilter('search', search.trim()) }} aria-label="Hotel filters">
        <TableToolbar>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Search hotels (name, ID, GIATA)</span><input type="search" value={search} maxLength={64} placeholder="Name, canonical ID or external ID" onChange={(event) => setSearch(event.target.value)} style={{ minWidth: 200 }} /></label>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Destination</span>
            <select value={filters.destination ?? ''} onChange={(event) => setFilter('destination', event.target.value)} style={selectStyle}><option value="">All destinations</option>{destinations.map((city) => <option key={city} value={city}>{city}</option>)}</select></label>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Readiness</span>
            <select value={filters.readiness ?? ''} onChange={(event) => setFilter('readiness', event.target.value)} style={selectStyle}><option value="">All</option><option value="READY">Ready</option><option value="PARTIAL">Partial</option><option value="BLOCKED">Blocked</option></select></label>
          <button type="submit" className="admin-btn">Search</button>
          {activeFilters > 0 && <button type="button" className="admin-btn" onClick={() => { setSearch(''); go({}) }}>Clear filters</button>}
        </TableToolbar>
        <details style={{ margin: '0 0 12px' }} open={Boolean(filters.supplierId || filters.contentStatus || filters.mapping || filters.contractState || filters.issue || filters.expiresWithinDays || filters.propertyType || filters.stars)}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>More filters</summary>
          <TableToolbar>
            {supplierOptions.length > 0 && <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Supplier</span><select value={filters.supplierId ?? ''} onChange={(event) => setFilter('supplierId', event.target.value)} style={selectStyle}><option value="">All suppliers</option>{supplierOptions.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select></label>}
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Property type</span><select value={filters.propertyType ?? ''} onChange={(event) => setFilter('propertyType', event.target.value)} style={selectStyle}><option value="">All</option>{HOTEL_PROPERTY_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}{filters.propertyType && !(HOTEL_PROPERTY_TYPES as readonly string[]).includes(filters.propertyType) && <option value={filters.propertyType}>{filters.propertyType}</option>}</select></label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Star category</span><select value={filters.stars ?? ''} onChange={(event) => setFilter('stars', event.target.value)} style={selectStyle}><option value="">All</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>)}<option value="UNRATED">Unrated</option></select></label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Profile approval</span><select value={filters.contentStatus ?? ''} onChange={(event) => setFilter('contentStatus', event.target.value)} style={selectStyle}><option value="">All</option>{['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED'].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Hotel mapping</span><select value={filters.mapping ?? ''} onChange={(event) => setFilter('mapping', event.target.value)} style={selectStyle}><option value="">All</option>{[['MAPPED', 'Mapped'], ['PENDING', 'Pending'], ['REJECTED', 'Rejected'], ['NONE', 'Not mapped']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Contract</span><select value={filters.contractState ?? ''} onChange={(event) => setFilter('contractState', event.target.value)} style={selectStyle}><option value="">All</option>{[['ACTIVE', 'Active'], ['EXPIRING', `Expiring (<${CONTRACT_EXPIRING_DAYS}d)`], ['EXPIRED', 'Expired'], ['INACTIVE', 'Inactive'], ['NONE', 'No contract']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Contract expires within</span><select value={filters.expiresWithinDays ?? ''} onChange={(event) => setFilter('expiresWithinDays', event.target.value)} style={selectStyle}><option value="">Any time</option>{CONTRACT_EXPIRY_FILTER_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Issue type</span><select value={filters.issue ?? ''} onChange={(event) => setFilter('issue', event.target.value)} style={{ minWidth: 180 }}><option value="">Any issue</option>
              {filters.issue && !(COMMERCIAL_ISSUE_CATEGORIES as readonly string[]).includes(filters.issue) && <option value={filters.issue}>{reasonText(filters.issue)}</option>}
              {COMMERCIAL_ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{c.split('_').join(' ').toLowerCase()}</option>)}</select></label>
          </TableToolbar>
        </details>
      </form>
      <OpsState state={list.state} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: activeFilters ? 'No hotels match these filters' : 'No hotels in this tenant', description: activeFilters ? 'The query succeeded and no hotel matches. Clear a filter to widen it.' : 'The query succeeded and this tenant has no hotels yet.' }}>
        {(data) => (
          <div className="workspace-panel" data-testid="hotels-table">
            <ScrollRegion label="Hotels">
              <table style={tableStyle} aria-label="Hotels and commercial readiness">
                <thead><tr>{['Hotel', 'Canonical ID', 'Location', 'Stars', 'Supplier mappings', 'Rooms', 'Profile', 'Contract', 'Rates', 'Inventory', 'Sellability', 'Issues', 'Updated', 'Action'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {data.items.map((hotel) => (
                    <tr key={hotel.id} data-hotel-id={hotel.id}>
                      <td style={{ ...td, minWidth: 190 }}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><HotelThumb hotel={hotel} /><div><Link href={hotelHref(hotel.id)} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{hotel.name}</Link><div style={{ color: '#3f565c', fontSize: 10 }}>{hotel.propertyType}{hotel.code ? ` · ${hotel.code}` : ''}{hotel.profile?.externalIdentifiers.length ? ` · ${hotel.profile.externalIdentifiers.map((i) => `${i.scheme} ${i.value}`).join(', ')}` : ''}</div></div></div></td>
                      <td style={td}><code data-testid="hotel-canonical-id" style={{ fontSize: 10 }}>{hotel.id}</code></td>
                      <td style={td}>{hotel.countryCode} · {hotel.city}{hotel.profile?.area ? <div style={{ color: '#3f565c', fontSize: 10 }}>{hotel.profile.area}</div> : null}</td>
                      <td style={td} title={starsText(hotel.starRating)}>{hotel.starRating ? <><span aria-hidden="true">{'★'.repeat(hotel.starRating)}</span><span className="sr-only">{starsText(hotel.starRating)}</span><div style={{ color: '#3f565c', fontSize: 10 }}>{hotel.profile ? (hotel.profile.starVerified ? 'Verified' : 'Unverified') : ''}</div></> : <span>Unrated</span>}</td>
                      <td style={td}><MappingChip value={hotel.hotelMapping} /><div style={{ color: '#3f565c', fontSize: 10, marginTop: 2 }}>{hotel.verifiedMappings} verified{hotel.suppliers.length ? ` · ${hotel.suppliers.map((s) => s.displayName).join(', ')}` : ''}</div></td>
                      <td style={td}>{hotel.rooms.active} active{hotel.rooms.total !== hotel.rooms.active ? ` / ${hotel.rooms.total}` : ''}<div style={{ color: '#3f565c', fontSize: 10 }}>{hotel.rooms.mapped} mapped</div></td>
                      <td style={td}><StatusBadge status={entityStatus(hotel.contentStatus)} /> <span style={{ fontSize: 10 }}>{hotel.contentStatus}</span><div style={{ color: '#3f565c', fontSize: 10 }}>{hotel.profile ? `${hotel.profile.completenessPercent}% complete${hotel.profile.exists ? '' : ' · no setup saved'}` : 'Profile unavailable'}</div></td>
                      <td style={td}><ContractChip value={hotel.contractState} days={hotel.contractDaysToExpiry} /></td>
                      <td style={td}><RatesChip value={hotel.rates} /></td>
                      <td style={td}><InventoryChip value={hotel.inventory} /></td>
                      <td style={td}><ReadinessChip value={hotel.readiness} blockers={hotel.blockers} /><div style={{ color: '#3f565c', fontSize: 10 }}>{data.window.days} nights from {data.window.from}</div></td>
                      <td style={{ ...td, minWidth: 190 }}>{hotel.issues.total === 0 ? '—' : <span title={hotel.blockers.map(reasonText).join('; ')}>{hotel.issues.total} issue{hotel.issues.total === 1 ? '' : 's'} · {hotel.issues.critical} critical · {hotel.issues.high} high</span>}{hotel.blockers[0] && <div style={{ fontSize: 10, whiteSpace: 'nowrap' }}><code>{hotel.blockers[0]}</code></div>}</td>
                      <td style={td}>{new Date(hotel.updatedAt).toLocaleDateString()}{hotel.profile?.updatedBy ? <div style={{ color: '#3f565c', fontSize: 10 }}>{hotel.profile.updatedBy}</div> : null}</td>
                      <td style={td}><Link href={hotelHref(hotel.id)}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <p style={{ color: '#3f565c', fontSize: 10, padding: '6px 14px', margin: 0 }}>{data.profilesAvailable ? '' : 'Profile details are unavailable to the API database role. '}Assessed for {data.window.from} → {data.window.to} ({data.window.days} nights).{data.scanCapped ? ' Filters covered only the first alphabetical hotels (scan limit reached).' : ''}</p>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => go(filters, p)} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

export default function HotelsPage() { return <Suspense fallback={<LoadingState rows={6} />}><HotelsList /></Suspense> }

/** The hotel's primary image, or its initial. No picture is ever invented (ADR 0027). */
function HotelThumb({ hotel }: { hotel: { id: string; name: string; primaryImage: { imageId: string; altText: string } | null } }) {
  const box = { width: 56, height: 42, borderRadius: 6, flex: 'none', overflow: 'hidden', background: '#eef3f5', color: '#3f565c', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 16 } as const
  const initial = <div style={box} aria-hidden="true" data-testid="hotel-initial">{hotel.name.trim().charAt(0).toUpperCase() || 'H'}</div>
  if (!hotel.primaryImage) return initial
  return <div style={box} data-testid="hotel-thumb"><AuthImage contentPath={`/admin/hotels/${hotel.id}/images/${hotel.primaryImage.imageId}/content`} alt={hotel.primaryImage.altText} width={56} height={42} fallback={initial} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>
}
