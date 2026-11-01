import { PageHeader } from '@/components/common/PageHeader'
import { RetryButton } from '@/components/common/RetryButton'
import { ApiResponseError } from '@/lib/api/errors'
import { classifyOpsFailure, failureReference, OPS_FAILURE_COPY } from '@/lib/ops-state'
import { AccessDenied, AuthRequired } from './AuthorizationStates'

/** Server-rendered failure for a page whose data could not be loaded. Never renders as an empty list; 5xx and unreachable errors offer a retry. */
export function ServerLoadFailure({ error, title, permission, subject, eyebrow = 'BUSINESS · ACCESS' }: { error: unknown; title: string; permission: string; subject: string; eyebrow?: string }) {
  if (error instanceof ApiResponseError && error.status === 401) return <div className="admin-page"><AuthRequired /></div>
  if (error instanceof ApiResponseError && error.status === 403) return <div className="admin-page"><AccessDenied permission={permission} /></div>
  const copy = OPS_FAILURE_COPY[classifyOpsFailure(error)]
  const reference = failureReference(error)
  return (
    <div className="admin-page">
      <PageHeader eyebrow={eyebrow} title={title} description={copy.title} />
      <section className="admin-auth-state" role="alert">
        <h2>Unable to load {subject}</h2>
        <p>{copy.body}</p>
        {reference ? <p>Reference: <code>{reference}</code></p> : null}
        <RetryButton />
      </section>
    </div>
  )
}
