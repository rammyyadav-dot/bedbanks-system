import { redirect } from 'next/navigation'
import { portalHref } from '../../lib/site-config'
export const metadata = { title: 'Operations portal', robots: { index: false, follow: false } }
export default function AdminPage() { redirect(portalHref('admin')) }
