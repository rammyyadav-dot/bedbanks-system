'use client'

import Link from 'next/link'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { getHotelContracts, getHotelMappings } from '@/lib/data/hotel-commercial'
import { getInventorySummary } from '@/lib/data/hotel-inventory'
import { hotelHref } from '@/lib/hotel-ui'
import { ProfileCard } from './HotelProfile'
import styles from './HotelProfile.module.css'

/** These views return authoritative linked records and coverage; the UI never recalculates eligibility or pooled stock. */
export function HotelOperationalSummary({ data }: { data: HotelCommercial360 }) {
  const can = useCan(), id = data.hotel.id
  const contractsAllowed = can('supply.contracts.read'), mappingAllowed = can('supply.mappings.read'), inventoryAllowed = can('supply.availability.read')
  const deps = [id, data.hotel.updatedAt, data.window.from, data.window.days]
  const contracts = useOpsQuery(() => contractsAllowed ? getHotelContracts(id, { from: data.window.from, days: data.window.days }) : Promise.resolve(null), [...deps, contractsAllowed])
  const mappings = useOpsQuery(() => mappingAllowed ? getHotelMappings(id) : Promise.resolve(null), [...deps, mappingAllowed])
  const inventory = useOpsQuery(() => inventoryAllowed ? getInventorySummary(id, { from: data.window.from, days: data.window.days }) : Promise.resolve(null), [...deps, inventoryAllowed])
  return <div className={styles.grid} data-testid="overview-linked-records">
    <ProfileCard title="Linked rooms" hotelId={id} tab={can('supply.rooms.read') ? 'rooms' : undefined} action="View">
      {!can('supply.rooms.read') ? <p className={styles.note}>Room details require room read permission.</p> : data.rooms.length ? <ul className={styles.list}>{data.rooms.map(r => <li key={r.id}><Link href={hotelHref(id, 'rooms', { roomTypeId: r.id })}>{r.name}</Link> · {r.isActive ? 'Active' : 'Archived'} · {r.ratePlans.active} active / {r.ratePlans.total} rate plans · {r.mapping}</li>)}</ul> : <p className={styles.note}>No canonical rooms recorded.</p>}
    </ProfileCard>
    <ProfileCard title="Contracts, rate plans & boards" hotelId={id} tab={contractsAllowed ? 'contracts' : undefined} action="View">
      {!contractsAllowed ? <p className={styles.note}>Contract summaries require contract read permission.</p> : <OpsState state={contracts.state} onRetry={contracts.reload}>{d => d && <>
        <p className={styles.note}>{d.contracts.length} linked contracts · {d.ratePlans.length} rate plans</p>
        {d.contracts.length ? <ul className={styles.list}>{d.contracts.map(c => <li key={c.id}><Link href={`/contracts/${c.id}`}>{c.code}</Link> · {c.state} · {c.validFrom} → {c.validTo}<br />Sales markets: {c.salesMarkets.length ? c.salesMarkets.join(', ') : 'Unrestricted'} · Guest nationalities: {c.nationalities.length ? c.nationalities.join(', ') : 'Unrestricted'}</li>)}</ul> : <p className={styles.note}>No linked contracts.</p>}
        <p className={styles.note}>Boards: {Array.from(new Set(d.ratePlans.map(p => `${p.boardCode}${p.boardActive ? '' : ' (inactive)'}`))).join(', ') || 'No rate-plan boards recorded'}</p>
      </>}</OpsState>}
    </ProfileCard>
    <ProfileCard title="Inventory coverage" hotelId={id} tab={inventoryAllowed ? 'inventory' : undefined} action="View">
      {!inventoryAllowed ? <p className={styles.note}>Inventory summaries require availability read permission.</p> : <OpsState state={inventory.state} onRetry={inventory.reload}>{d => d && <>
        <p className={styles.text}>{d.totals.plans} rate plans · {d.totals.pooledPlans} pooled plans · {d.totals.pools} active pools</p>
        <p className={styles.note}>{d.totals.nightsMissing} missing nights · {d.totals.nightsStale} stale nights</p>
        <p className={styles.note}>Assessed {d.window.from} → {d.window.to}. Shared stock is not summed across plans.</p>
      </>}</OpsState>}
    </ProfileCard>
    <ProfileCard title="Supplier identity mappings" hotelId={id} tab={mappingAllowed ? 'mappings' : undefined} action="View">
      {!mappingAllowed ? <p className={styles.note}>Mapping details require mapping read permission.</p> : <OpsState state={mappings.state} onRetry={mappings.reload}>{d => d && <>
        <p className={styles.note}>{d.hotelMappings.length} hotel mappings · {d.roomMappings.length} room mappings</p>
        {d.hotelMappings.length ? <ul className={styles.list}>{d.hotelMappings.map(m => <li key={m.id}>{m.supplierName} · <code>{m.supplierHotelId}</code> · {m.status}</li>)}</ul> : <p className={styles.note}>No supplier identities recorded.</p>}
      </>}</OpsState>}
    </ProfileCard>
    <ProfileCard title="Distribution eligibility" hotelId={id} tab={can('supply.rates.read') ? 'sellability' : undefined} action="Inspect">
      <p className={styles.text}>Commercial readiness: {data.readiness}<br />Buyer-independent supply coverage: {data.agentSellable ? 'Available in the assessed window' : 'Not available in the assessed window'}</p>
      <p className={styles.note}>Profile activation is not sellability. Each Agent search and recheck enforces its dates, mapped identities, active contract, board, rates, inventory, sales market and guest nationality. Use Distribution & Readiness for a stated stay.</p>
    </ProfileCard>
  </div>
}
