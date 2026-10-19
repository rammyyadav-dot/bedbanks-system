import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="supplier-page" style={{ maxWidth: 720, margin: '10vh auto', padding: 24 }}>
      <h1>Page not found</h1>
      <p>This page does not exist, or it is not part of your organization.</p>
      <Link className="btn btn-primary" href="/dashboard">Return to workspace</Link>
    </main>
  )
}
