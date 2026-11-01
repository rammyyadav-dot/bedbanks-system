'use client'

import { useEffect } from 'react'
import { TriangleAlert } from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader'

export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest correlates with the server log; the message is never shown or logged client-side because it can carry supplier data.
    console.error(JSON.stringify({ level: 'error', event: 'supplier_portal_render_failed', digest: error.digest ?? null }))
  }, [error.digest])

  return (
    <div className="supplier-page" role="alert">
      <PageHeader eyebrow="Error" title="This page could not be loaded" description="Something went wrong while loading this page. No substitute data is shown and nothing was changed." />
      <section className="panel unavailable-panel">
        <span className="capability-icon is-danger"><TriangleAlert size={26} aria-hidden="true" /></span>
        <div>
          <h2>Something went wrong</h2>
          {error.digest && <p>Reference for support: <code>{error.digest}</code></p>}
          <div className="unavailable-actions"><button className="btn btn-primary" type="button" onClick={reset}>Try again</button></div>
        </div>
      </section>
    </div>
  )
}
