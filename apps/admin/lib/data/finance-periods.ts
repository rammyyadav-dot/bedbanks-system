// Admin finance period close (ADR 0101). No mock or fallback data lives here.
import { routes, type FinancePeriodPage, type FinancePeriodPreview, type FinancePeriodView } from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

const p = routes.adminFinancePeriods
export const getFinancePeriods = (q: Record<string, string | number | undefined>) => apiRequest<FinancePeriodPage>(`${p.list}${opsQuery(q)}`)
export const previewFinancePeriod = (month: string) => apiRequest<FinancePeriodPreview>(`${p.preview}${opsQuery({ month })}`)
export const closeFinancePeriod = (month: string, note?: string) => apiRequest<FinancePeriodView>(p.close, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, ...(note ? { note } : {}) }) })
