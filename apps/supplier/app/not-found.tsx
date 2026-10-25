import Link from 'next/link'
import { BrandLogo } from '../components/brand/BrandLogo'

export default function NotFound() {
  return (
    <main className="standalone-page">
      <div className="standalone-card">
        <BrandLogo width={130} />
        <p className="page-eyebrow is-muted"><i />Error 404</p>
        <h1>Page not found</h1>
        <p>This page does not exist, or it is not part of your organization.</p>
        <Link className="btn btn-primary" href="/dashboard">Return to workspace</Link>
      </div>
    </main>
  )
}
