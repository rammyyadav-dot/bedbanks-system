import { PageHeader } from '@/components/common/PageHeader'
import { ApiResponseError } from '@/lib/api/errors'
import { AccessDenied, AuthRequired } from './AuthorizationStates'

export function ServerLoadFailure({ error, title, permission, subject, eyebrow = 'BUSINESS · ACCESS', source = 'platform access API' }: { error: unknown; title: string; permission: string; subject: string; eyebrow?: string; source?: string }) {
  if (error instanceof ApiResponseError && error.status === 401) return <div className="admin-page"><AuthRequired /></div>
  if (error instanceof ApiResponseError && error.status === 403) return <div className="admin-page"><AccessDenied permission={permission} /></div>
  if (error instanceof ApiResponseError && error.status === 404) return <div className="admin-page"><PageHeader eyebrow={eyebrow} title={title} description={`The requested ${subject} does not exist.`} /></div>
  return <div className="admin-page"><PageHeader eyebrow={eyebrow} title={title} description={`The ${source} could not be reached.`} /><section className="admin-auth-state"><h2>Unable to load {subject}</h2><p>Retry after confirming API availability.</p></section></div>
}
