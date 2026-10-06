import type { HotelStayReadiness, HotelStayReadinessGate, SellabilityPlanResult } from '@bedbanks/contracts'
import { SELLABILITY_GATES } from '../supply/commercial-assessment'

type Criteria = { agencyId: string | null; market: string | null; nationality: string | null; currency: 'AED' | null; children: number }
const groups = [
  { key: 'content', label: 'Published hotel and room', source: ['hotel', 'room'], tab: 'setup', permission: 'supply.hotels.read' },
  { key: 'mapping', label: 'Supplier hotel and room mapping', source: ['mapping'], tab: 'mappings', permission: 'supply.mappings.read' },
  { key: 'contract', label: 'Supplier, contract and plan', source: ['supplier', 'contract', 'plan'], tab: 'contracts', permission: 'supply.contracts.read' },
  { key: 'rate', label: 'Rate and currency', source: ['rate'], tab: 'rates', permission: 'supply.rates.read' },
  { key: 'inventory', label: 'Stock, occupancy and stay rules', source: ['availability', 'stopSell', 'inventory', 'occupancy', 'stay'], tab: 'inventory', permission: 'supply.availability.read' },
  { key: 'distribution', label: 'Buyer eligibility', source: ['buyer'], tab: 'sellability', permission: 'supply.rates.read' },
] as const

/** Presentation only: reasons are supplied by the canonical evaluator and the existing agency controls.
 * A gate is per plan and per request. It cannot certify search, recheck, child policies or a hosted deployment.
 */
export function buildHotelStayReadiness(hotelId: string, plans: SellabilityPlanResult[], evaluatedAt: string, criteria: Criteria): HotelStayReadiness {
  const buyerAssessed = Boolean(criteria.agencyId && criteria.market && criteria.nationality)
  return {
    scope: 'STAY_DIAGNOSTIC_NOT_CERTIFICATION',
    buyer: { agencyId: criteria.agencyId, market: criteria.market, nationality: criteria.nationality, assessed: buyerAssessed },
    requestedCurrency: criteria.currency,
    occupancy: { uniformRooms: true, childPolicyAssessed: false },
    certification: 'NOT_VERIFIED',
    plans: plans.map(plan => {
      const entityRefs = { hotelId, roomTypeId: plan.roomTypeId, ratePlanId: plan.ratePlanId, contractId: plan.contractId ?? null, supplierId: plan.supplierId ?? null }
      const classified = new Set(SELLABILITY_GATES.flatMap(gate => gate.reasons))
      const gates: HotelStayReadinessGate[] = groups.map(group => {
        const codes = SELLABILITY_GATES.filter(g => (group.source as readonly string[]).includes(g.key)).flatMap(g => g.reasons)
        const reasons = plan.reasons.filter(reason => codes.includes(reason))
        // An unfamiliar evaluator reason must not disappear behind a green checklist.
        if (group.key === 'contract') reasons.push(...plan.reasons.filter(reason => !classified.has(reason)))
        let state: HotelStayReadinessGate['state'] = reasons.length ? 'FAIL' : 'PASS'
        if (group.key === 'distribution' && !buyerAssessed && !reasons.length) { state = 'UNKNOWN'; reasons.push('BUYER_CONTEXT_NOT_ASSESSED') }
        if (group.key === 'rate' && !criteria.currency && !reasons.length) { state = 'UNKNOWN'; reasons.push('REQUEST_CURRENCY_NOT_SPECIFIED') }
        if (group.key === 'inventory' && criteria.children > 0 && !reasons.length) { state = 'UNKNOWN'; reasons.push('CHILD_POLICY_NOT_ASSESSED') }
        return { key: group.key, label: group.label, state, reasons, entityRefs, evaluatedAt, criteriaRef: 'request', action: { tab: group.tab, permission: group.permission } }
      })
      gates.push({ key: 'search_recheck', label: 'Agent search and authoritative recheck certification', state: 'UNKNOWN', reasons: ['SEARCH_RECHECK_NOT_CERTIFIED'], entityRefs, evaluatedAt, criteriaRef: 'request', action: null })
      return { ratePlanId: plan.ratePlanId, gates }
    }),
  }
}
