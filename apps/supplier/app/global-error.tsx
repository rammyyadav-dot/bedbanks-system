'use client'

import './globals.css'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="standalone-page" role="alert">
          <div className="standalone-card">
            <p className="page-eyebrow is-muted"><i />fabBeds supplier extranet</p>
            <h1>The supplier portal is unavailable</h1>
            <p>The page could not be rendered. No data was changed.</p>
            <button className="btn btn-primary" type="button" onClick={reset}>Try again</button>
          </div>
        </main>
      </body>
    </html>
  )
}
