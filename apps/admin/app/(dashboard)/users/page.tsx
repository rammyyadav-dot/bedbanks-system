import Link from 'next/link'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="BUSINESS" title="Users" reason={<>View tenant members, roles and access flags in <Link href="/access-review">Access review</Link>. Manage role assignments in <Link href="/access">Roles &amp; Permissions</Link>.</>} />
}
