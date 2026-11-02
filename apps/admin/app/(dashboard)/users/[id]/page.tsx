import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="BUSINESS" title="User" reason={<>Open the tenant under <Link href="/tenants">Tenants</Link> and use Users &amp; access. Platform roles and assignments remain under <Link href="/access">Roles &amp; Permissions</Link>.</>} />
}
