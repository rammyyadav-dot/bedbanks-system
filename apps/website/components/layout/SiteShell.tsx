import { Footer } from './Footer'
import { Header } from './Header'

export function SiteShell({ children }: { children: React.ReactNode }) {
  return <div className="site-shell"><a className="skip-link" href="#main-content">Skip to main content</a><p className="status-banner" role="note">fBeds is in early build-out. Live inventory, bookings and portal sign-in are not generally available yet.</p><Header /><main id="main-content">{children}</main><Footer /></div>
}
