import { redirect } from 'next/navigation'
import { portalHref } from '../../lib/site-config'
export const metadata = { title: 'Supplier portal', robots: { index: false, follow: false } }
export default function SupplierPage() { redirect(portalHref('supplier')) }
