import { createHash } from 'node:crypto'

/**
 * Content binding for rate plan activation approval (ADR 0057, S5). Pure.
 *
 * The fingerprint covers the commercial terms of the plan and every rate row from `asOf` onward, so an approval covers exactly what the
 * approver was shown. A change to a price, a term or a night added after the request makes the approval unusable (the requester files a new one).
 * Stock counters (sold, held, allotment) are deliberately excluded: they move with every booking and are not a commercial term.
 */
export interface FingerprintPlan {
  contractId: string; roomTypeId: string; boardBasisId: string; code: string; occupancy: number; currency: string
  refundable: boolean; taxesIncluded: boolean; feesIncluded: boolean; minStay: number; maxStay: number | null
  releaseDays: number; releaseTimeLocal: string; inventoryPoolId: string | null
  validFrom: Date | null; validTo: Date | null; paymentType: string | null; cancellationPolicySet: string | null
  salesMarkets: unknown; nationalities: unknown
}
export interface FingerprintGuestLine { kind: string; minAge: number; maxAge: number; amountMinor: bigint; amountBasis: string; currency: string }
export interface FingerprintRate { stayDate: Date; occupancy: number; amountMinor: bigint; amountBasis: string | null; currency: string }

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const sortedList = (value: unknown): unknown => (Array.isArray(value) ? [...value].map(String).sort() : value)

/** Canonical JSON: fixed key order, bigint as decimal string, lists sorted. Never includes ids of people or any free text. */
export function canonicalPlanContent(plan: FingerprintPlan, rates: readonly FingerprintRate[], asOf: string, guestLines: readonly FingerprintGuestLine[] = []): string {
  return JSON.stringify({
    v: 2, asOf,
    plan: {
      contractId: plan.contractId, roomTypeId: plan.roomTypeId, boardBasisId: plan.boardBasisId, code: plan.code, occupancy: plan.occupancy, currency: plan.currency,
      refundable: plan.refundable, taxesIncluded: plan.taxesIncluded, feesIncluded: plan.feesIncluded, minStay: plan.minStay, maxStay: plan.maxStay,
      releaseDays: plan.releaseDays, releaseTimeLocal: plan.releaseTimeLocal, inventoryPoolId: plan.inventoryPoolId,
      validFrom: day(plan.validFrom), validTo: day(plan.validTo), paymentType: plan.paymentType, cancellationPolicySet: plan.cancellationPolicySet,
      salesMarkets: sortedList(plan.salesMarkets), nationalities: sortedList(plan.nationalities),
    },
    guest: guestLines.map((line) => [line.kind, line.minAge, line.maxAge, line.amountMinor.toString(), line.amountBasis, line.currency]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2])),
    rates: rates.filter((row) => day(row.stayDate)! >= asOf)
      .map((row) => [day(row.stayDate), row.occupancy, row.amountMinor.toString(), row.amountBasis, row.currency])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1])),
  })
}

export const planFingerprint = (plan: FingerprintPlan, rates: readonly FingerprintRate[], asOf: string, guestLines: readonly FingerprintGuestLine[] = []): string =>
  createHash('sha256').update(canonicalPlanContent(plan, rates, asOf, guestLines)).digest('hex')
