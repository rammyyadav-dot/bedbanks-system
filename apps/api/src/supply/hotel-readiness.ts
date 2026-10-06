import {
  COMMERCIAL_REASON_TEXT, HOTEL_STAR_RATING_MISSING,
  type HotelCompleteness, type HotelReadinessAssessment, type HotelReadinessCriteria, type ReadinessAction, type ReadinessActionTab, type ReadinessBlocker,
  type ReadinessEntityRef, type ReadinessGateId, type ReadinessGateOutcome, type ReadinessGateResult,
} from '@bedbanks/contracts'
import { evaluateContractedStay } from './contracted-sellability'
import { buildStaySnapshot } from './stay-snapshot'
import { markupResolverFor } from './markup-rules'
import { mappingFor, SELLABILITY_GATES, type AssessHotelInput } from './commercial-assessment'

/**
 * Unified hotel readiness for ONE explicit set of criteria. Pure: no I/O, no clock (`now` is injected).
 *
 * It composes, and does not replace, the existing authoritative rules:
 *  - content: `assessCompleteness` (publication requirements, ADR 0021), passed in as data;
 *  - everything commercial: `evaluateContractedStay`, the evaluator Agent search, recheck and hold use, with the buyer context;
 *  - catalogue eligibility and agency controls: the same conditions Agent search applies (published and rated hotel, agency not suspended,
 *    no hotel or supplier distribution restriction).
 * Each plan's reasons are sorted into gates by `GATE_OF_REASON`. A gate fails only when no candidate plan is clear of that gate's reasons.
 * The verdict additionally requires that at least one plan passes every gate, so gates that pass on different plans cannot add up to "ready".
 */
export interface AgencyEvidence { id: string; name: string; status: string; hotelRestricted: boolean; restrictedSupplierIds: string[] }
export interface ReadinessInput {
  criteria: HotelReadinessCriteria
  now: Date
  assess: AssessHotelInput
  /** null: the profile tables are not readable by the API database role. */
  content: HotelCompleteness | null
  /** null: no agency was requested. 'UNREADABLE': the agency or its restrictions could not be read. */
  agency: AgencyEvidence | null | 'UNREADABLE'
  supplierNames: Map<string, string>
}

const COMMERCIAL: ReadonlyArray<ReadinessGateId> = ['CONTENT', 'MAPPING', 'CONTRACT', 'RATE', 'INVENTORY', 'DISTRIBUTION']
const LABEL: Record<ReadinessGateId, string> = {
  CONTENT: 'Content readiness', MAPPING: 'Mapping readiness', CONTRACT: 'Contract readiness', RATE: 'Rate readiness', INVENTORY: 'Inventory readiness',
  DISTRIBUTION: 'Distribution readiness', SEARCH_RECHECK_EVIDENCE: 'Search and recheck certification evidence',
}
const ACTION: Record<Exclude<ReadinessGateId, 'CONTENT'>, ReadinessAction> = {
  MAPPING: { tab: 'mappings', label: 'Review supplier mappings', permission: 'supply.mappings.manage' },
  CONTRACT: { tab: 'contracts', label: 'Review contracts and rate plans', permission: 'supply.contracts.manage' },
  RATE: { tab: 'rates', label: 'Review the rates calendar', permission: 'supply.rates.manage' },
  INVENTORY: { tab: 'inventory', label: 'Review inventory and allotment', permission: 'supply.availability.manage' },
  DISTRIBUTION: { tab: 'sellability', label: 'Review distribution and publication', permission: 'supply.hotels.manage' },
  SEARCH_RECHECK_EVIDENCE: { tab: 'sellability', label: 'Inspect sellability for these criteria', permission: 'supply.rates.read' },
}
const SECTION_TAB: Record<string, ReadinessActionTab> = { identity: 'setup', location: 'setup', classification: 'setup', content: 'setup', operations: 'setup', contacts: 'setup', governance: 'setup', rooms: 'rooms' }

/**
 * Which readiness gate owns a canonical reason. Derived from the shared `SELLABILITY_GATES` table (the same table the inspector and the per-plan
 * stay diagnostic use), so a reason added there is classified here too. A reason that table does not list (for example a market rule) fails
 * closed into CONTRACT rather than being ignored.
 */
const GATE_OF_KEY: Record<string, ReadinessGateId> = {
  hotel: 'DISTRIBUTION', supplier: 'CONTRACT', mapping: 'MAPPING', room: 'CONTRACT', contract: 'CONTRACT', plan: 'CONTRACT', rate: 'RATE',
  availability: 'INVENTORY', stopSell: 'INVENTORY', inventory: 'INVENTORY', occupancy: 'CONTRACT', stay: 'CONTRACT',
}
const GATE_OF_REASON: Record<string, ReadinessGateId> = Object.fromEntries(SELLABILITY_GATES.flatMap((g) => g.reasons.map((reason) => [reason, GATE_OF_KEY[g.key] ?? 'CONTRACT'])))
const gateOf = (reason: string): ReadinessGateId => GATE_OF_REASON[reason] ?? 'CONTRACT'
const textOf = (code: string): string => COMMERCIAL_REASON_TEXT[code] ?? code

interface PlanOutcome { plan: AssessHotelInput['plans'][number]; reasons: string[]; eligible: boolean; offer: boolean }

export function assessReadiness(input: ReadinessInput): HotelReadinessAssessment {
  const { criteria, assess, now } = input
  const evaluatedAt = now.toISOString()
  const dates = assess.dates
  const hotelRef: ReadinessEntityRef = { type: 'HOTEL', id: assess.hotel.id, label: assess.hotel.name }
  const starOk = assess.hotel.starRating !== null && assess.hotel.starRating >= 1 && assess.hotel.starRating <= 5

  // One evaluation per plan, with the buyer, exactly as Agent search would run it. Rates are the plan's own occupancy only.
  const outcomes: PlanOutcome[] = assess.plans.map((loaded) => {
    const plan = { ...loaded, dailyRates: loaded.dailyRates.filter((rate) => rate.occupancy === loaded.occupancy) }
    const { mapping, roomMapping } = mappingFor(plan, assess)
    const decision = evaluateContractedStay(
      buildStaySnapshot(plan, mapping, roomMapping, dates, markupResolverFor(assess.markupRules ?? [], plan.contract.supplierId, plan.roomType.hotelId)),
      { checkIn: criteria.checkIn, checkOut: criteria.checkOut, rooms: criteria.rooms, adults: criteria.adults, children: criteria.children, currency: criteria.currency, now, buyer: { nationality: criteria.nationality, market: criteria.market } },
    )
    const reasons = [...decision.reasons]
    if (!starOk) reasons.push(HOTEL_STAR_RATING_MISSING)
    return { plan: loaded, reasons, eligible: decision.eligible, offer: reasons.length === 0 && decision.eligible }
  })

  // Agency controls remove plans the buyer could never be shown; they are a distribution matter, not a rate matter.
  const agency = input.agency
  const restrictedSupplier = (supplierId: string): boolean => agency !== null && agency !== 'UNREADABLE' && (agency.hotelRestricted || agency.restrictedSupplierIds.includes(supplierId))
  const agencySuspended = agency !== null && agency !== 'UNREADABLE' && agency.status === 'SUSPENDED'
  const published = assess.hotel.contentStatus === 'COMPLETE'
  const predictedOffers = published && agency !== 'UNREADABLE' && !agencySuspended ? outcomes.filter((o) => o.offer && !restrictedSupplier(o.plan.contract.supplierId)).length : 0

  const refsOf = (o: PlanOutcome): ReadinessEntityRef[] => [
    { type: 'ROOM_TYPE', id: o.plan.roomTypeId, label: o.plan.roomType.name }, { type: 'RATE_PLAN', id: o.plan.id, label: o.plan.code },
    { type: 'CONTRACT', id: o.plan.contract.id, label: o.plan.contract.code }, { type: 'SUPPLIER', id: o.plan.contract.supplierId, label: o.plan.contract.supplier.displayName },
  ]
  const dedupe = (refs: ReadinessEntityRef[]): ReadinessEntityRef[] => [...new Map(refs.map((r) => [`${r.type}:${r.id}`, r])).values()]
  const nightsInStay = dates.length

  const result = (gate: ReadinessGateId, outcome: ReadinessGateOutcome, over: Partial<ReadinessGateResult> & { criteriaApplied: string[] }): ReadinessGateResult => ({
    gate, label: LABEL[gate], outcome, blockers: [], reason: null, notes: [], evaluatedAt, action: outcome === 'PASS' ? null : gate === 'CONTENT' ? { tab: 'setup', label: 'Complete the hotel profile', permission: 'supply.hotels.manage' } : ACTION[gate], ...over,
  })

  // ---- CONTENT: publication requirements only. Whether the hotel is published is a distribution matter. -------------------------------------------
  const content = ((): ReadinessGateResult => {
    const criteriaApplied = ['Publication requirements for the hotel profile (ADR 0021)']
    if (input.content === null) return result('CONTENT', 'UNKNOWN', { criteriaApplied, reason: 'The API database role cannot read the hotel profile, so completeness cannot be judged. This is not a failure of the content.' })
    const unmet = input.content.requirements.filter((r) => !r.met)
    if (unmet.length === 0) return result('CONTENT', 'PASS', { criteriaApplied })
    const blockers: ReadinessBlocker[] = unmet.map((r) => ({ code: r.key, message: `${r.label}: ${r.detail}`, refs: [hotelRef], nights: null }))
    const tab = SECTION_TAB[unmet[0].section] ?? 'setup'
    return result('CONTENT', 'FAIL', { criteriaApplied, blockers, action: { tab, label: tab === 'rooms' ? 'Add or restore a canonical room' : 'Complete the hotel profile', permission: tab === 'rooms' ? 'supply.rooms.manage' : 'supply.hotels.manage' } })
  })()

  // ---- plan-driven gates --------------------------------------------------------------------------------------------------------------------------
  const planGate = (gate: Exclude<ReadinessGateId, 'CONTENT' | 'DISTRIBUTION' | 'SEARCH_RECHECK_EVIDENCE'>, criteriaApplied: string[], whenNoPlans: () => ReadinessGateResult): ReadinessGateResult => {
    if (outcomes.length === 0) return whenNoPlans()
    const failing = outcomes.filter((o) => o.reasons.some((r) => gateOf(r) === gate))
    const clear = outcomes.length - failing.length
    const blockersOf = (list: PlanOutcome[]): ReadinessBlocker[] => {
      const byCode = new Map<string, PlanOutcome[]>()
      for (const o of list) for (const r of new Set(o.reasons.filter((x) => gateOf(x) === gate))) byCode.set(r, [...(byCode.get(r) ?? []), o])
      return [...byCode.entries()].map(([code, os]) => ({ code, message: `${textOf(code)} (${os.length} rate plan${os.length === 1 ? '' : 's'})`, refs: dedupe(os.flatMap(refsOf)).slice(0, 40), nights: nightsInStay })).sort((a, b) => a.code.localeCompare(b.code))
    }
    if (clear > 0) return result(gate, 'PASS', { criteriaApplied, notes: failing.length ? [`${failing.length} of ${outcomes.length} rate plans have problems at this gate; ${clear} do not.`] : [] })
    return result(gate, 'FAIL', { criteriaApplied, blockers: blockersOf(failing) })
  }
  const stayCriteria = `Stay ${criteria.checkIn} to ${criteria.checkOut} (${criteria.nights} night${criteria.nights === 1 ? '' : 's'}), ${criteria.rooms} room${criteria.rooms === 1 ? '' : 's'}, ${criteria.adults} adult${criteria.adults === 1 ? '' : 's'}${criteria.children ? ` and ${criteria.children} child${criteria.children === 1 ? '' : 'ren'}` : ''} per the rate plan occupancy`
  const buyerCriteria = `Buyer: nationality ${criteria.nationality ?? 'not supplied'}, market ${criteria.market ?? 'not known'}`

  const mapping = planGate('MAPPING', [`Approved hotel and room mapping for each rate plan's supplier`], () => {
    const states = assess.mappings.map((m) => m.status)
    if (states.includes('MAPPED')) return result('MAPPING', 'PASS', { criteriaApplied: ['Approved hotel mapping exists; no rate plan exists yet to judge room mappings'], notes: ['No rate plan exists, so room mappings were not judged.'] })
    return result('MAPPING', 'FAIL', { criteriaApplied: ['Approved hotel mapping'], blockers: [{ code: 'SUPPLIER_MAPPING_INVALID', message: states.length ? `${textOf('SUPPLIER_MAPPING_INVALID')} (hotel mapping is ${states.join(', ')})` : `${textOf('SUPPLIER_MAPPING_INVALID')} (no supplier hotel mapping)`, refs: [hotelRef, ...assess.mappings.map((m): ReadinessEntityRef => ({ type: 'MAPPING', id: m.id, label: m.supplierName }))], nights: null }] })
  })
  const contract = planGate('CONTRACT', [stayCriteria, buyerCriteria, `Currency ${criteria.currency}; contract validity, sales markets, nationalities, stay and release rules, room occupancy limits`], () =>
    result('CONTRACT', 'FAIL', { criteriaApplied: [stayCriteria], blockers: [{ code: 'RATE_PLAN_MISSING', message: textOf('RATE_PLAN_MISSING'), refs: [hotelRef], nights: null }] }))
  const noPlan = (gate: 'RATE' | 'INVENTORY'): ReadinessGateResult => result(gate, 'NOT_APPLICABLE', { criteriaApplied: [stayCriteria], reason: 'No rate plan exists for this hotel, so there are no rates or inventory to evaluate. See Contract readiness.' })
  const rate = planGate('RATE', [`Every stay night priced in ${criteria.currency}; a missing price is unknown, never zero; NET rates need a markup rule`], () => noPlan('RATE'))
  const inventory = planGate('INVENTORY', ['Every stay night: availability row present, not stop-sold, not closed, fresh, stock remaining (plan counter or shared pool); closed-to-arrival and closed-to-departure; hotel-local release deadline'], () => noPlan('INVENTORY'))

  // ---- DISTRIBUTION -------------------------------------------------------------------------------------------------------------------------------
  const distribution = ((): ReadinessGateResult => {
    const criteriaApplied = ['Catalogue eligibility: profile COMPLETE and a 1-5 star rating', agency === null ? 'No agency supplied: agency suspension and agency distribution restrictions were NOT evaluated' : 'Agency suspension and agency distribution restrictions']
    const blockers: ReadinessBlocker[] = []
    if (assess.hotel.contentStatus !== 'COMPLETE') blockers.push({ code: 'HOTEL_INACTIVE', message: `${textOf('HOTEL_INACTIVE')} (${assess.hotel.contentStatus})`, refs: [hotelRef], nights: null })
    if (!starOk) blockers.push({ code: HOTEL_STAR_RATING_MISSING, message: textOf(HOTEL_STAR_RATING_MISSING), refs: [hotelRef], nights: null })
    if (agency === 'UNREADABLE') return result('DISTRIBUTION', blockers.length ? 'FAIL' : 'UNKNOWN', { criteriaApplied, blockers, reason: blockers.length ? null : 'The agency or its distribution restrictions could not be read, so agency controls are unknown. This is not treated as unrestricted.' })
    if (agency !== null) {
      const ref: ReadinessEntityRef = { type: 'AGENCY', id: agency.id, label: agency.name }
      if (agency.status === 'SUSPENDED') blockers.push({ code: 'AGENCY_SUSPENDED', message: 'The agency is suspended and cannot search, recheck or hold', refs: [ref], nights: null })
      if (agency.hotelRestricted) blockers.push({ code: 'DISTRIBUTION_RESTRICTED_HOTEL', message: 'The agency is restricted from this hotel', refs: [ref, hotelRef], nights: null })
      const suppliers = [...new Set(assess.plans.map((p) => p.contract.supplierId))]
      const blocked = suppliers.filter((s) => agency.restrictedSupplierIds.includes(s))
      if (!agency.hotelRestricted && suppliers.length > 0 && blocked.length === suppliers.length) blockers.push({ code: 'DISTRIBUTION_RESTRICTED_SUPPLIER', message: 'The agency is restricted from every supplier that sells this hotel', refs: [ref, ...blocked.map((id): ReadinessEntityRef => ({ type: 'SUPPLIER', id, label: input.supplierNames.get(id) ?? null }))], nights: null })
    }
    return blockers.length ? result('DISTRIBUTION', 'FAIL', { criteriaApplied, blockers }) : result('DISTRIBUTION', 'PASS', { criteriaApplied, notes: agency === null ? ['Agency-specific controls were not evaluated; supply an agency to evaluate them.'] : [] })
  })()

  // ---- evidence: nothing is persisted per hotel, so this is UNKNOWN by construction, never inferred from the prediction -----------------------------
  const evidence = result('SEARCH_RECHECK_EVIDENCE', 'UNKNOWN', {
    criteriaApplied: [`Evaluator-predicted offers for these criteria: ${predictedOffers}`],
    reason: 'Search and recheck outcomes are audited per offer, not per hotel, and no per-hotel certification record exists. The predicted offer count is the shared evaluator’s answer for these criteria, not evidence that Agent search or recheck ran.',
  })

  const gates = [content, mapping, contract, rate, inventory, distribution, evidence]
  const commercial = gates.filter((g) => COMMERCIAL.includes(g.gate))
  const noSinglePlan = commercial.every((g) => g.outcome === 'PASS' || g.outcome === 'NOT_APPLICABLE') && predictedOffers === 0
  const commercialVerdict: HotelReadinessAssessment['commercialVerdict'] = commercial.some((g) => g.outcome === 'FAIL') || noSinglePlan ? 'FAIL' : commercial.some((g) => g.outcome === 'UNKNOWN') ? 'UNKNOWN' : 'PASS'
  const limitations = [
    'Evaluated only for the criteria above. It does not imply availability on other dates, occupancies, nationalities, agencies or suppliers.',
    ...(noSinglePlan ? ['Each gate passes on some rate plan, but no single rate plan passes every gate for these criteria, so nothing would be offered.'] : []),
    ...(criteria.children > 0 ? ['Child ages are recorded with the request, but the evaluator judges occupancy by head count against the room limits and the rate plan occupancy; no per-age child pricing or bed policy is modelled.'] : []),
    `Prices are judged in ${criteria.currency} only; no currency conversion policy exists.`,
  ]
  return {
    hotelId: assess.hotel.id, hotelName: assess.hotel.name, evaluatedAt, criteria, gates, commercialVerdict, predictedOffers,
    scope: 'These results apply to the stated stay, occupancy, nationality, agency and currency at the evaluation time only.', limitations,
  }
}
