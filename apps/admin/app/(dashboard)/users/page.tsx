import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="BUSINESS" title="Users" reason={<>Tenant members, membership roles and access keys are managed per agency under <Link href="/tenants">Tenants</Link>. Review access flags in <Link href="/access-review">Access review</Link>. Formal role bundles stay in <Link href="/access">Roles &amp; Permissions</Link>.</>} />
}
