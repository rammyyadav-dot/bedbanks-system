import { redirect } from 'next/navigation'
import { portalHref } from '../../lib/site-config'
export const metadata = { title: 'Agent portal', robots: { index: false, follow: false } }
export default function AgentPage() { redirect(portalHref('agent')) }
