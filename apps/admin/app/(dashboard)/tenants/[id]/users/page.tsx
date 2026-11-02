import { TenantUsers } from '@/components/tenants/TenantUsers'

export default async function TenantUsersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <TenantUsers id={id} />
}
