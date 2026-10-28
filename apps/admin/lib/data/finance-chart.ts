// Admin general-ledger chart of accounts and journal (ADR 0102). No mock or fallback data lives here.
import { routes, type GlAccountCreateRequest, type GlAccountView, type GlChartView, type GlJournalView, type GlMappingSetRequest, type GlMappingView } from '@bedbanks/contracts'
import { apiDownload, apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

const c = routes.adminFinanceChart
const post = <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export const getGlChart = () => apiRequest<GlChartView>(c.chart)
export const initializeGlChart = () => post<GlChartView>(c.initialize)
export const createGlAccount = (body: GlAccountCreateRequest) => post<GlAccountView>(c.accounts, body)
export const deactivateGlAccount = (id: string) => post<GlAccountView>(c.deactivate.replace(':accountId', encodeURIComponent(id)))
export const setGlMapping = (body: GlMappingSetRequest) => post<GlMappingView>(c.mappings, body)
export const downloadGlJournal = (month: string, kind: 'lines' | 'totals') => apiDownload(`${c.journalExport}${opsQuery({ month, kind })}`)
export const getGlJournal = (month: string) => apiRequest<GlJournalView>(`${c.journal}${opsQuery({ month })}`)
