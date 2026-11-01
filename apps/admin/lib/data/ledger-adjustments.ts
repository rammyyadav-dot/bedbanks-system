// Admin ledger adjustments and reversals (ADR 0100). No mock or fallback data lives here.
import { routes, type LedgerAdjustmentPage, type LedgerAdjustmentProposeRequest, type LedgerAdjustmentView } from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

const a = routes.adminLedgerAdjustments
const fill = (path: string, adjustmentId: string) => path.replace(':adjustmentId', encodeURIComponent(adjustmentId))
const post = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const getLedgerAdjustments = (p: Record<string, string | number | undefined>) => apiRequest<LedgerAdjustmentPage>(`${a.list}${opsQuery(p)}`)
export const proposeLedgerAdjustment = (body: LedgerAdjustmentProposeRequest) => post<LedgerAdjustmentView>(a.list, body)
export const approveLedgerAdjustment = (id: string) => post<LedgerAdjustmentView>(fill(a.approve, id), {})
export const rejectLedgerAdjustment = (id: string, reason: string) => post<LedgerAdjustmentView>(fill(a.reject, id), { reason })
