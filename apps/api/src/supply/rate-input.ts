import { BadRequestException } from '@nestjs/common'
import { enabledCurrency } from '../agent/currency'

/** Strict calendar dates: Date alone normalizes impossible dates such as 2030-02-31. */
export function calendarDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Use a YYYY-MM-DD date')
  const result = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new BadRequestException('Invalid calendar date')
  return result
}

export function positiveMinor(value: unknown): bigint {
  if (!((typeof value === 'string' && /^[0-9]{1,19}$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value)))) throw new BadRequestException('amountMinor must be an integer minor-unit amount')
  const amount = BigInt(value)
  if (amount <= 0n || amount > 9223372036854775807n) throw new BadRequestException('amountMinor must be positive and fit PostgreSQL bigint')
  return amount
}

function integer(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 2147483647) throw new BadRequestException(`Invalid ${name}`)
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || value.trim() !== value) throw new BadRequestException('Invalid rate plan id')
  return value
}
function expected(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new BadRequestException('Invalid expectedUpdatedAt')
  return value
}
export function rateInput(input: Record<string, unknown>) {
  const amountMinor = positiveMinor(input.amountMinor)
  if (input.amountBasis !== 'NET' && input.amountBasis !== 'SELL') throw new BadRequestException('Invalid rate basis')
  return { ratePlanId: id(input.ratePlanId), stayDate: calendarDate(input.stayDate), occupancy: integer(input.occupancy, 'occupancy', 1), amountMinor, amountBasis: input.amountBasis as 'NET' | 'SELL', currency: enabledCurrency(input.currency), expectedUpdatedAt: expected(input.expectedUpdatedAt) }
}
export function availabilityInput(input: Record<string, unknown>) {
  // Stock consumption belongs to holds/bookings, never an Admin price edit.
  if (input.sold !== undefined && input.sold !== 0) throw new BadRequestException('Sold inventory cannot be authored')
  if (input.held !== undefined) throw new BadRequestException('Held inventory cannot be authored')
  if (input.stopSell !== undefined && typeof input.stopSell !== 'boolean') throw new BadRequestException('Invalid stop sell')
  return { ratePlanId: id(input.ratePlanId), stayDate: calendarDate(input.stayDate), allotment: integer(input.allotment, 'allotment', 0), stopSell: input.stopSell as boolean | undefined, minStay: input.minStay === undefined ? undefined : integer(input.minStay, 'minimum stay', 1), expectedUpdatedAt: expected(input.expectedUpdatedAt) }
}
export function inputRows(value: unknown, kind: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 366 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new BadRequestException(`Provide 1 to 366 ${kind} rows`)
  return value
}
export function uniqueRows(rows: Array<{ ratePlanId: string; stayDate: Date; occupancy?: number }>): void {
  const keys = rows.map(row => JSON.stringify([row.ratePlanId, row.stayDate.toISOString(), row.occupancy ?? null]))
  if (new Set(keys).size !== keys.length) throw new BadRequestException('Duplicate cells in the same batch are not allowed')
}
