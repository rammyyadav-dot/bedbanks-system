import { portalHref } from '../../lib/site-config'
import { Footer } from './Footer'
import { Header } from './Header'

export function SiteShell({ children }: { children: React.ReactNode }) {
  return <div className="site-shell"><a className="skip-link" href="#main-content">Skip to main content</a><Header agentHref={portalHref('agent')} /><main id="main-content">{children}</main><Footer /></div>
}
