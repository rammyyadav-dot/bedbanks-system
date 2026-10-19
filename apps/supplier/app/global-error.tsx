'use client'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main style={{ maxWidth: 720, margin: '10vh auto', padding: 24, fontFamily: 'system-ui, sans-serif' }} role="alert">
          <h1>The supplier portal is unavailable</h1>
          <p>The page could not be rendered. No data was changed.</p>
          <button type="button" onClick={reset}>Try again</button>
        </main>
      </body>
    </html>
  )
}
