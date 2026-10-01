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
