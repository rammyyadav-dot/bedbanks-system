import { PageHeader } from '@/components/common/PageHeader'
import { ApiResponseError } from '@/lib/api/errors'
import { AccessDenied, AuthRequired } from './AuthorizationStates'

export function ServerLoadFailure({ error, title, permission, subject }: { error: unknown; title: string; permission: string; subject: string }) {
  if (error instanceof ApiResponseError && error.status === 401) return <div className="admin-page"><AuthRequired /></div>
  if (error instanceof ApiResponseError && error.status === 403) return <div className="admin-page"><AccessDenied permission={permission} /></div>
  return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title={title} description="The platform access API could not be reached." /><section className="admin-auth-state"><h2>Unable to load {subject}</h2><p>Retry after confirming API availability.</p></section></div>
}
