'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { PlanPicker } from '@/components/commercial/PlanPicker'
import { LoadingState } from '@/components/common/LoadingState'
import { ErrorState } from '@/components/common/ErrorState'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Chip } from '@/components/hotels/ui'
import { QuickUpdatePanel } from '@/components/hotels/panels/QuickUpdatePanel'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { getRatePlans, type AdminRatePlan } from '@/lib/data'
import { getHotel360 } from '@/lib/data/hotel-commercial'
import { getRateCertificationPlan } from '@/lib/data/rate-certification'
import { hotelHref } from '@/lib/hotel-ui'
import { certificationTone } from '@/lib/rate-certification-ui'
import { FindingList } from './FindingList'
import { NightGrid } from './NightGrid'

/**
 * One rate plan at a time: its findings and night-by-night grid from the audit, and the existing hotel Quick Update beside them.
 * The audit stays read-only. Every edit goes through Quick Update's preview, permission checks, idempotency and audit event,
 * and the audit is re-read afterwards so the findings reflect what was saved.
 */
export function Workbench({ ratePlanId, days, onSelect }: { ratePlanId: string; days: number; onSelect: (ratePlanId: string) => void }) {
  const can = useCan()
  const canQuickUpdate = can('supply.rates.read') && (can('supply.rates.manage') || can('supply.availability.manage'))
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [loadingPlans, setLoadingPlans] = useState(true)
  const [planError, setPlanError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    getRatePlans().then((rows) => { if (active) setPlans(rows) }).catch((error) => { if (active) setPlanError(describeApiError(error, 'load rate plans')) }).finally(() => { if (active) setLoadingPlans(false) })
    return () => { active = false }
  }, [])
  if (loadingPlans) return <LoadingState rows={3} />
  if (planError) return <ErrorState title="Rate plans unavailable" description={`${planError} No fallback data is shown.`} />
  return (
    <div style={{ display: 'grid', gap: 12 }} data-testid="workbench">
      <section className="admin-filter-bar" aria-label="Workbench rate plan selection">
        <PlanPicker plans={plans} ratePlanId={ratePlanId} onChange={onSelect} />
      </section>
      {plans.length === 0 ? <div className="admin-empty"><strong>No rate plans yet</strong><span>Create a contract and a rate plan first.</span></div>
        : !plans.some((p) => p.id === ratePlanId) ? <p role="status" style={{ fontSize: 12 }}>Choose a hotel, room and rate plan to see its findings and edit its rates.</p>
        : <WorkbenchPlan key={ratePlanId} ratePlanId={ratePlanId} hotelId={plans.find((p) => p.id === ratePlanId)!.roomType.hotel.id} days={days} canQuickUpdate={canQuickUpdate} />}
    </div>
  )
}

function WorkbenchPlan({ ratePlanId, hotelId, days, canQuickUpdate }: { ratePlanId: string; hotelId: string; days: number; canQuickUpdate: boolean }) {
  const audit = useOpsQuery(() => getRateCertificationPlan(ratePlanId, { days }), [ratePlanId, days])
  return (
    <div style={{ display: 'grid', gap: 12 }}>
    <OpsState state={audit.state} onRetry={audit.reload}>
      {(d) => (
        <div style={{ display: 'grid', gap: 12 }} data-testid="workbench-plan" data-status={d.live ? d.status : 'NOT_LIVE'}>
          <section className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 6 }} aria-label="Selected rate plan">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 15 }}><code>{d.code}</code></strong>
              {d.live ? <Chip tone={certificationTone(d.status)}>{d.status}</Chip> : <Chip tone="neutral">NOT LIVE</Chip>}
              <Link href={hotelHref(d.hotelId)}>{d.hotelName}</Link>
              <Link href={`/rate-certification/${encodeURIComponent(d.ratePlanId)}`}>Full audit</Link>
              <Link href={`/rate-certification?tab=simulator&ratePlanId=${encodeURIComponent(d.ratePlanId)}`}>Simulate a stay</Link>
            </div>
            <div style={{ fontSize: 12, color: 'var(--c-3f565c)' }}>{d.roomName} · {d.boardCode} · occupancy {d.occupancy} · {d.currency} · contract {d.contractCode} ({d.contractStatus}) · sellable nights {d.sellableNights} of {d.nights}</div>
          </section>
          <section className="workspace-panel" style={{ padding: 14 }} aria-label="Findings"><h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Findings</h2><FindingList findings={d.findings} emptyText="No findings: every check passed for this plan." /></section>
          <section className="workspace-panel" aria-label="Rate grid"><NightGrid detail={d} /></section>
        </div>
      )}
    </OpsState>
    {/* Outside the audit's loading state so changing the window or re-reading the audit never discards an unsaved draft or preview. */}
    <section aria-label="Quick update">
      <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Quick update</h2>
      {canQuickUpdate
        ? <WorkbenchQuickUpdate hotelId={hotelId} ratePlanId={ratePlanId} onChanged={audit.refresh} />
        : <p role="status" style={{ fontSize: 12 }}>You have read-only access to rates and inventory, so editing is not available.</p>}
    </section>
    </div>
  )
}

function WorkbenchQuickUpdate({ hotelId, ratePlanId, onChanged }: { hotelId: string; ratePlanId: string; onChanged: () => void }) {
  const hotel = useOpsQuery(() => getHotel360(hotelId), [hotelId])
  return <OpsState state={hotel.state} onRetry={hotel.reload}>{(data) => <QuickUpdatePanel hotelId={hotelId} data={data} initialRatePlanIds={[ratePlanId]} onChanged={onChanged} />}</OpsState>
}
