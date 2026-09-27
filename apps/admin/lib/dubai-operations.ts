export type RateOperationPlan = { id: string; occupancy: number; currency: string; minStay: number }

function sevenDates(startDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) throw new Error('Invalid start date')
  return Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(start)
    day.setUTCDate(day.getUTCDate() + offset)
    return day.toISOString().slice(0, 10)
  })
}

export function buildSevenDayRates(plan: RateOperationPlan, startDate: string, amountMajor: string, amountBasis: 'SELL' | 'NET') {
  const amountMinor = Math.round(Number(amountMajor) * 100)
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('Invalid amount')
  return sevenDates(startDate).map(stayDate => ({ ratePlanId: plan.id, stayDate, occupancy: plan.occupancy, amountMinor: String(amountMinor), amountBasis, currency: plan.currency }))
}

export function buildSevenDayAvailability(plan: RateOperationPlan, startDate: string, allotmentValue: string, stopSell: boolean) {
  const allotment = Number(allotmentValue)
  if (!Number.isInteger(allotment) || allotment < 0) throw new Error('Invalid allotment')
  return sevenDates(startDate).map(stayDate => ({ ratePlanId: plan.id, stayDate, allotment, sold: 0, stopSell, minStay: plan.minStay }))
}

export function sellabilityMessage(result: { eligible: boolean; status: string; reasons: string[] }) {
  return result.eligible ? `Sellable: ${result.status}` : `Not sellable: ${result.reasons.join(', ')}`
}
