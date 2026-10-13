'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { RatePlanReadiness } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { ActivationApprovalPanel } from '@/components/hotels/panels/ActivationApprovalPanel'
import { Chip } from '@/components/hotels/ui'
import { useCan } from '@/lib/auth/capabilities'
import { getRatePlan, getRatePlanReadiness } from '@/lib/data'
import { nextStep, summariseSteps, type WizardStepKey } from '@/lib/rate-plan-wizard'
import { RatePlanForm } from './RatePlanForm'
import { DerivationPanel } from './DerivationPanel'
import { GuestPricesPanel } from './GuestPricesPanel'
import { PromotionsPanel } from './PromotionsPanel'

/**
 * Guided setup of one rate plan (S4). The server's readiness checks decide what is done; this screen only orders them into steps, shows what still needs
 * attention on each, and ends at the activation request. Nothing here activates a plan by itself: going live always goes through readiness and, where required, a second person.
 */
export function RatePlanWizard({ ratePlanId }: { ratePlanId: string }) {
  const can = useCan()
  const readiness = useOpsQuery<RatePlanReadiness>(() => getRatePlanReadiness(ratePlanId), [ratePlanId])
  const plan = useOpsQuery(() => getRatePlan(ratePlanId), [ratePlanId])
  const [step, setStep] = useState<WizardStepKey | null>(null)
  const [requesting, setRequesting] = useState(false)

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · RATE PLANS" title="Guided setup" description="Work through the steps in order. Each step shows what the platform still needs before the plan can sell. Nothing sells until the plan is activated." />
      <OpsState state={readiness.state} onRetry={readiness.reload}>
        {(data) => {
          const summaries = summariseSteps(data.checks)
          const active: WizardStepKey = step ?? nextStep(summaries)
          const current = summaries.find((s) => s.step.key === active)!
          return (
            <>
              <nav aria-label="Setup steps" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0 14px' }}>
                {summaries.map((s) => (
                  <button key={s.step.key} type="button" className={`admin-btn${s.step.key === active ? ' admin-btn-primary' : ''}`} aria-current={s.step.key === active ? 'step' : undefined} data-step={s.step.key} data-state={s.state}
                    onClick={() => { setStep(s.step.key); readiness.refresh() }}>
                    {s.step.title} <Chip tone={s.state === 'ready' ? 'ok' : 'warn'}>{s.state === 'ready' ? 'READY' : `${s.failing.length} TO FIX`}</Chip>
                  </button>
                ))}
              </nav>
              <p style={{ fontSize: 12, color: '#3f565c', margin: '0 0 8px' }}>{current.step.help}</p>
              {current.failing.length ? (
                <ul aria-label="Still needed" style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12 }}>
                  {current.failing.map((c) => <li key={c.code} data-check={c.code}><strong>{c.label}</strong>: {c.message}</li>)}
                </ul>
              ) : <p role="status" style={{ fontSize: 12, color: '#1f7a5a' }}>Nothing more is needed on this step.</p>}

              {active === 'terms' ? <RatePlanForm ratePlanId={ratePlanId} termsOnly /> : null}
              {active === 'pricing' ? (
                <>
                  <DerivationPanel ratePlanId={ratePlanId} />
                  <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16 }} aria-label="Enter rates and stock">
                    <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Rates and stock</h2>
                    <p style={{ margin: '0 0 8px', fontSize: 12 }}>A plan with its own rates needs a nightly rate and an availability row for every night it sells. Enter them on the grid, or import a CSV, then come back here.</p>
                    <Link className="admin-btn" href={`/rates?ratePlanId=${ratePlanId}`}>Open Rates &amp; Inventory</Link>
                  </section>
                </>
              ) : null}
              {active === 'extras' ? <><GuestPricesPanel ratePlanId={ratePlanId} /><PromotionsPanel ratePlanId={ratePlanId} /></> : null}
              {active === 'review' ? (
                <section className="workspace-panel" style={{ maxWidth: 760, padding: 22 }} aria-label="Review and go live">
                  <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Full checklist</h2>
                  <ul style={{ margin: '0 0 12px', paddingLeft: 0, listStyle: 'none', fontSize: 12 }}>
                    {data.checks.map((c) => <li key={c.code} data-check={c.code} data-ok={c.ok} style={{ padding: '2px 0' }}><Chip tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'PASS' : 'FAIL'}</Chip> <strong>{c.label}</strong>{c.ok ? '' : `: ${c.message}`}</li>)}
                  </ul>
                  <OpsState state={plan.state} onRetry={plan.reload}>
                    {(loaded) => (
                      data.status === 'ACTIVE' ? <p role="status" style={{ fontSize: 12 }}>This plan is active.</p>
                        : requesting ? <ActivationApprovalPanel plan={loaded} onClose={() => { setRequesting(false); readiness.reload() }} onDone={() => { setRequesting(false); readiness.reload() }} />
                        : <button type="button" className="admin-btn admin-btn-primary" disabled={!data.ready || !can('supply.rates.manage')} onClick={() => setRequesting(true)} data-action="request-activation">
                            {data.ready ? 'Request activation' : 'Fix the items above to request activation'}
                          </button>
                    )}
                  </OpsState>
                </section>
              ) : null}
              <p style={{ fontSize: 12, marginTop: 14 }}><Link href={`/rates/plans/${ratePlanId}`}>Open the full plan page</Link></p>
            </>
          )
        }}
      </OpsState>
    </div>
  )
}
