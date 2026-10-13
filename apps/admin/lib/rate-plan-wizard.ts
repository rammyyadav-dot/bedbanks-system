import type { RatePlanReadinessCheck } from '@bedbanks/contracts'

/**
 * The guided rate plan setup (S4). The steps follow how a hotel contract is loaded in the large bedbanks: what the plan is, how it is priced, what is added
 * on top (children, promotions), then a go-live review. Each step's state comes from the server's own readiness checks, never from a second opinion here.
 */
export type WizardStepKey = 'terms' | 'pricing' | 'extras' | 'review'
export interface WizardStep { key: WizardStepKey; title: string; help: string; codes: readonly string[] }

export const WIZARD_STEPS: readonly WizardStep[] = [
  { key: 'terms', title: '1. Plan terms', help: 'Room, board, stay rules, sale window, markets, cancellation and payment type.',
    codes: ['STATUS_ALLOWED', 'CONTRACT_ACTIVE', 'CONTRACT_VALID', 'CONTRACT_MAPPED', 'ROOM_ACTIVE', 'BOARD_ACTIVE', 'OCCUPANCY_VALID', 'STAY_RULES_VALID', 'PLAN_VALIDITY', 'PLAN_MARKETS', 'CANCELLATION_POLICY', 'CURRENCY_MATCH'] },
  { key: 'pricing', title: '2. Prices and stock', help: 'Its own nightly rates, or derived from another plan, and the availability it sells from.',
    codes: ['RATES_PRESENT', 'RATES_CONTIGUOUS', 'RATES_CLASSIFIED', 'RATES_CURRENCY', 'RATES_POSITIVE', 'DERIVED_PARENT_VALID', 'INVENTORY_LINKED'] },
  { key: 'extras', title: '3. Children and promotions', help: 'Child and extra-adult prices, and promotions such as early bird or free nights. Optional.',
    codes: ['GUEST_PRICES_VALID', 'PROMOTIONS_VALID'] },
  { key: 'review', title: '4. Review and go live', help: 'The full checklist, then a request for a second person to approve the activation.', codes: [] },
]

export type StepState = 'ready' | 'attention'
export interface StepSummary { step: WizardStep; state: StepState; failing: RatePlanReadinessCheck[]; passing: number }

/**
 * A step needs attention while any of its checks fails. A check this module does not know about is never hidden: it lands on the review step, so a new
 * server rule cannot be missed by the guided flow.
 */
export function summariseSteps(checks: readonly RatePlanReadinessCheck[]): StepSummary[] {
  const known = new Set(WIZARD_STEPS.flatMap((step) => step.codes))
  return WIZARD_STEPS.map((step) => {
    const mine = step.key === 'review' ? checks.filter((c) => !known.has(c.code)) : checks.filter((c) => step.codes.includes(c.code))
    const failing = mine.filter((c) => !c.ok)
    return { step, state: failing.length === 0 ? 'ready' : 'attention', failing, passing: mine.length - failing.length }
  })
}

/** The first step that still needs attention, or the review step when everything before it is ready. */
export function nextStep(summaries: readonly StepSummary[]): WizardStepKey {
  return summaries.find((s) => s.step.key !== 'review' && s.state === 'attention')?.step.key ?? 'review'
}
