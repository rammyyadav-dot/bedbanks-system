import { parseMajorToMinor } from './minor-units'

export type RateOperationPlan = { id: string; occupancy: number; currency: string; minStay: number }

export function dateRange(startDate: string, days = 7) {
  const start = new Date(`${startDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) throw new Error('Invalid start date')
  return Array.from({ length: days }, (_, offset) => {
    const day = new Date(start)
    day.setUTCDate(day.getUTCDate() + offset)
    return day.toISOString().slice(0, 10)
  })
}

function parseAmountMinor(amountMajor: string, currency: string) {
  const amountMinor = parseMajorToMinor(amountMajor, currency)
  if (amountMinor === null) throw new Error('Invalid amount')
  return amountMinor
}

export function buildSevenDayRates(plan: RateOperationPlan, startDate: string, amountMajor: string, amountBasis: 'SELL' | 'NET', days = 7) {
  const amountMinor = parseAmountMinor(amountMajor, plan.currency)
  return dateRange(startDate, days).map(stayDate => ({ ratePlanId: plan.id, stayDate, occupancy: plan.occupancy, amountMinor, amountBasis, currency: plan.currency }))
}

export function buildSevenDayAvailability(plan: RateOperationPlan, startDate: string, allotmentValue: string, stopSell: boolean, days = 7) {
  const allotment = Number(allotmentValue)
  if (!Number.isInteger(allotment) || allotment < 0) throw new Error('Invalid allotment')
  return dateRange(startDate, days).map(stayDate => ({ ratePlanId: plan.id, stayDate, allotment, stopSell, minStay: plan.minStay }))
}

export function sellabilityMessage(result: { eligible: boolean; status: string; reasons: string[] }) {
  return result.eligible ? `Sellable: ${result.status}` : `Not sellable: ${result.reasons.join(', ')}`
}

export function buildCancellationPolicyWrite(input: {
  daysBeforeCheckinValue: string
  mode: 'PERCENTAGE' | 'FIXED'
  penaltyValue: string
  currency: string
}) {
  const daysBeforeCheckin = Number(input.daysBeforeCheckinValue.trim())
  if (!Number.isInteger(daysBeforeCheckin) || daysBeforeCheckin < 0 || !input.daysBeforeCheckinValue.trim()) {
    throw new Error('Invalid days before check-in')
  }
  const currency = input.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency')
  if (input.mode === 'PERCENTAGE') {
    const penaltyPercent = Number(input.penaltyValue.trim())
    if (!Number.isInteger(penaltyPercent) || penaltyPercent < 0 || penaltyPercent > 100 || !input.penaltyValue.trim()) {
      throw new Error('Invalid penalty percent')
    }
    return { daysBeforeCheckin, penaltyPercent, currency }
  }
  const penaltyMinor = parseAmountMinor(input.penaltyValue, currency)
  return { daysBeforeCheckin, penaltyMinor, currency }
}

export function buildCancellationSimulationPayload(input: {
  checkIn: string
  requestedAt: string
  currency: string
  cancellableAmountMajor: string
  nightlyAmountsMajorCsv?: string
  customerAmountPaidMajor?: string
  retainedFeesMajor?: string
  priorRefundsMajor?: string
  policyType: 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL'
  deadlineSemantics: 'CALENDAR_DAYS_AT_LOCAL_TIME' | 'ELAPSED_HOURS'
  propertyTimeZone?: string
  checkInLocalTime?: string
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.checkIn.trim())) throw new Error('Invalid check-in date')
  const requestedAtMs = Date.parse(input.requestedAt.trim())
  if (Number.isNaN(requestedAtMs)) throw new Error('Invalid cancellation timestamp')
  const currency = input.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency')
  const cancellableAmountMinor = parseAmountMinor(input.cancellableAmountMajor, currency)
  const nightlyAmountsMinor = input.nightlyAmountsMajorCsv?.trim()
    ? input.nightlyAmountsMajorCsv.split(',').map(part => parseAmountMinor(part, currency))
    : undefined
  const customerAmountPaidMinor = input.customerAmountPaidMajor?.trim() ? parseAmountMinor(input.customerAmountPaidMajor, currency) : undefined
  const retainedFeesMinor = input.retainedFeesMajor?.trim() ? parseAmountMinor(input.retainedFeesMajor, currency) : undefined
  const priorRefundsMinor = input.priorRefundsMajor?.trim() ? parseAmountMinor(input.priorRefundsMajor, currency) : undefined

  return {
    checkIn: input.checkIn.trim(),
    requestedAt: new Date(requestedAtMs).toISOString(),
    currency,
    cancellableAmountMinor,
    ...(nightlyAmountsMinor ? { nightlyAmountsMinor } : {}),
    ...(customerAmountPaidMinor ? { customerAmountPaidMinor } : {}),
    ...(retainedFeesMinor ? { retainedFeesMinor } : {}),
    ...(priorRefundsMinor ? { priorRefundsMinor } : {}),
    policyType: input.policyType,
    deadlineSemantics: input.deadlineSemantics,
    ...(input.propertyTimeZone?.trim() ? { propertyTimeZone: input.propertyTimeZone.trim() } : {}),
    ...(input.checkInLocalTime?.trim() ? { checkInLocalTime: input.checkInLocalTime.trim() } : {}),
  }
}
