/**
 * When the nightly ledger integrity run is due, and when a missing run is a problem (ADR 0064). Pure date arithmetic on UTC calendar dates;
 * no clock, no database. A run's date is the UTC date it was taken on, and a tenant has at most one per date.
 */
export const DEFAULT_RUN_HOUR_UTC = 1
/** Hours after the scheduled time before a missing run is reported as overdue (the scheduler checks every few minutes, so this is generous). */
export const OVERDUE_GRACE_HOURS = 3
const HOUR_MS = 3_600_000

/** `YYYY-MM-DD` of the UTC date. */
export const runDateUtc = (now: Date): string => now.toISOString().slice(0, 10)

const slotOf = (date: string, hour: number): number => Date.parse(`${date}T00:00:00.000Z`) + hour * HOUR_MS
const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00.000Z`) - 24 * HOUR_MS).toISOString().slice(0, 10)

export function assertRunHour(hour: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('LEDGER_INTEGRITY_RUN_HOUR_UTC must be an integer from 0 to 23')
  return hour
}

/** Due once today's scheduled time has passed and today's run does not exist yet. A missed night is therefore caught up as soon as the service is back. */
export function isRunDue(now: Date, hour: number, hasRunToday: boolean): boolean {
  return !hasRunToday && now.getTime() >= slotOf(runDateUtc(now), hour)
}

/** The most recent run date whose scheduled time plus the grace period has already passed: a run for it should exist. */
export function expectedRunDate(now: Date, hour: number, graceHours = OVERDUE_GRACE_HOURS): string {
  const today = runDateUtc(now)
  return now.getTime() >= slotOf(today, hour) + graceHours * HOUR_MS ? today : dayBefore(today)
}

export type ScheduleState = 'NEVER_RUN' | 'OK' | 'OVERDUE'

/** NEVER_RUN: nothing stored. OVERDUE: the latest stored run is older than the expected date. Otherwise OK. */
export function scheduleState(now: Date, hour: number, latestRunDate: string | null, graceHours = OVERDUE_GRACE_HOURS): ScheduleState {
  if (latestRunDate === null) return 'NEVER_RUN'
  return latestRunDate < expectedRunDate(now, hour, graceHours) ? 'OVERDUE' : 'OK'
}
