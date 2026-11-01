'use client'

/** Last-resort boundary for failures in the root layout itself. It cannot rely on app CSS, so it is self-contained. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 32 }}>
        <main role="alert">
          <h1>The Admin Console could not load</h1>
          <p>Nothing was changed. Retry, and contact support if this continues.</p>
          {error.digest ? <p>Reference: <code>{error.digest}</code></p> : null}
          <button type="button" onClick={reset}>Retry</button>
        </main>
      </body>
    </html>
  )
}
