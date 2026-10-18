import type { LedgerIntegrityRunsView } from '@bedbanks/contracts'

export interface ScheduleBanner { tone: 'ok' | 'warn' | 'bad' | 'neutral'; label: string; detail: string }

const hh = (hour: number) => `${String(hour).padStart(2, '0')}:00 UTC`

/**
 * What the nightly record's health means in words. Colour never carries the meaning alone: the label always says it.
 * A switched-off scheduler is a normal, explicit state, never an empty list pretending to be a clean history.
 */
export function scheduleBanner(v: LedgerIntegrityRunsView): ScheduleBanner {
  const when = hh(v.scheduler.runHourUtc)
  if (v.schedule === 'NEVER_RUN') {
    return v.scheduler.enabled
      ? { tone: 'warn', label: 'No nightly run yet', detail: `The nightly run is switched on and takes its first record after ${when}. Until then only the live check below is available.` }
      : { tone: 'neutral', label: 'Nightly run is not switched on', detail: 'No nightly record is being kept in this environment. An administrator must provision the ledger-audit database role and enable the run (see the runbook). Until then only the live check below is available.' }
  }
  const latest = v.latest
  if (v.schedule === 'OVERDUE') {
    return { tone: 'bad', label: 'Nightly run is overdue', detail: `The record for ${v.expectedRunDate} is missing${latest ? `; the latest is ${latest.runDate}` : ''}. The run is expected after ${when}${v.scheduler.enabled ? '' : ' but it is not switched on in this environment'}. Treat the ledger as unchecked since then.` }
  }
  if (latest?.status === 'FAIL') return { tone: 'bad', label: 'Latest night has errors', detail: `${latest.runDate}: ${latest.errors} error${latest.errors === 1 ? '' : 's'}, ${latest.warnings} warning${latest.warnings === 1 ? '' : 's'}. Open it below.` }
  if (latest?.status === 'WARN') return { tone: 'warn', label: 'Latest night needs attention', detail: `${latest.runDate}: ${latest.warnings} warning${latest.warnings === 1 ? '' : 's'}.` }
  return { tone: 'ok', label: 'Nightly record is current', detail: `Latest ${latest?.runDate}: consistent. Runs daily after ${when}.` }
}
