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

function parseAmountMinor(amountMajor: string) {
  const normalized = amountMajor.trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match) throw new Error('Invalid amount')
  const major = BigInt(match[1])
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'))
  const amountMinor = major * 100n + fraction
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid amount')
  return amountMinor.toString()
}

export function buildSevenDayRates(plan: RateOperationPlan, startDate: string, amountMajor: string, amountBasis: 'SELL' | 'NET') {
  const amountMinor = parseAmountMinor(amountMajor)
  return sevenDates(startDate).map(stayDate => ({ ratePlanId: plan.id, stayDate, occupancy: plan.occupancy, amountMinor, amountBasis, currency: plan.currency }))
}

export function buildSevenDayAvailability(plan: RateOperationPlan, startDate: string, allotmentValue: string, stopSell: boolean) {
  const allotment = Number(allotmentValue)
  if (!Number.isInteger(allotment) || allotment < 0) throw new Error('Invalid allotment')
  return sevenDates(startDate).map(stayDate => ({ ratePlanId: plan.id, stayDate, allotment, stopSell, minStay: plan.minStay }))
}

export function sellabilityMessage(result: { eligible: boolean; status: string; reasons: string[] }) {
  return result.eligible ? `Sellable: ${result.status}` : `Not sellable: ${result.reasons.join(', ')}`
}
