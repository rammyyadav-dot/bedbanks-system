import { TenantDetail } from '@/components/tenants/TenantDetail'
export default async function TenantPage({params}:{params:Promise<{id:string}>}) {const {id}=await params;return <TenantDetail id={id}/>}
