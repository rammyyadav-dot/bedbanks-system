// Supplier statement reconciliation and the dispute queue (ADR 0070). No mock or fallback data lives here.
import {
  routes, type Paged, type ReconDecisionRequest, type ReconExceptionDetail, type ReconExceptionSummary, type ReconExceptionView, type ReconProposeRequest, type ReconRunRequest, type ReconRunView,
  type StatementDetail, type StatementImportRequest, type StatementView,
} from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

const r = routes.adminFinanceReconciliation
const fill = (path: string, name: string, id: string) => path.replace(`:${name}`, encodeURIComponent(id))
const post = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
type Params = Record<string, string | number | undefined>

export const getReconStatements = (p: Params) => apiRequest<Paged<StatementView>>(`${r.statements}${opsQuery(p)}`)
export const getReconStatement = (id: string) => apiRequest<StatementDetail>(fill(r.statement, 'statementId', id))
export const importReconStatement = (body: StatementImportRequest) => post<StatementView>(r.statements, body)
export const requestReconRun = (statementId: string, body: ReconRunRequest) => post<ReconRunView>(fill(r.run, 'statementId', statementId), body)

export const getReconExceptions = (p: Params) => apiRequest<Paged<ReconExceptionView>>(`${r.exceptions}${opsQuery(p)}`)
export const getReconSummary = () => apiRequest<ReconExceptionSummary>(r.exceptionSummary)
export const getReconException = (id: string) => apiRequest<ReconExceptionDetail>(fill(r.exception, 'exceptionId', id))
export const proposeReconDecision = (id: string, body: ReconProposeRequest) => post<ReconExceptionDetail>(fill(r.propose, 'exceptionId', id), body)
export const approveReconDecision = (id: string, body: ReconDecisionRequest) => post<ReconExceptionDetail>(fill(r.approve, 'exceptionId', id), body)
export const rejectReconDecision = (id: string, body: ReconDecisionRequest) => post<ReconExceptionDetail>(fill(r.reject, 'exceptionId', id), body)
