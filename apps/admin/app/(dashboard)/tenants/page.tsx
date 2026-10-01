import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="BUSINESS" title="Tenants" reason="Tenant and user administration is not enabled in this console yet. Platform roles and assignments are managed under Roles & Permissions." />
}
