'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Plus, Search } from 'lucide-react'
import { routes, type TenantDirectory as Directory } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { PageHeader } from '@/components/common/PageHeader'
import { TenantWizard } from './TenantWizard'
export function TenantDirectory() {
  const router = useRouter(), [data,setData] = useState<Directory|null>(null), [error,setError] = useState(''), [loading,setLoading] = useState(true), [wizard,setWizard] = useState(false), [retry,setRetry] = useState(0)
  const [filters,setFilters] = useState({search:'',status:'',classification:'',country:'',createdFrom:'',createdTo:'',sort:'name',order:'asc',page:1})
  useEffect(() => { let valid=true; const t=setTimeout(async () => {
    setLoading(true);setError('')
    const q=new URLSearchParams();Object.entries(filters).forEach(([k,v]) => {if(v!=='')q.set(k,String(v))})
    try {const d=await apiRequest<Directory>(`${routes.platform.tenants}?${q}`); if(valid)setData(d)} catch(e){if(valid){setData(null);setError(e instanceof Error?e.message:'Tenant directory unavailable')}} finally{if(valid)setLoading(false)}
  },200);return()=>{valid=false;clearTimeout(t)} },[filters,retry])
  const set = (key:string,value:string)=>setFilters(f=>({...f,[key]:value,page:1}))
  const metricLabels: Record<string,string> = {total:'Total tenants',active:'Active tenants',pendingReview:'Pending review',suspended:'Suspended tenants',newThisMonth:'Created this month',incomplete:'Incomplete profiles'}
  return <div className="admin-page tenant-control">
    <PageHeader eyebrow="BUSINESS" title="Tenant Control Center" description="Business identity, access and lifecycle governance across the fBeds platform." actions={data?.authoringConfigured && data.permissions.includes('platform.tenants.create') && data.permissions.includes('platform.tenants.memberships.manage') ? <button className="admin-btn tenant-primary" onClick={()=>setWizard(true)}><Plus size={15}/>Create tenant</button> : undefined} />
    {data && <div className="tenant-kpis">{Object.entries(data.metrics).map(([key,v])=><div className="tenant-kpi" key={key}><span>{metricLabels[key]}</span><strong>{v??'Unavailable'}</strong></div>)}</div>}
    <section className="tenant-panel"><div className="tenant-panel-head"><div className="tenant-section-title"><Building2 size={17}/><h2>Tenant directory</h2></div><span>{data?.total??'—'} businesses</span></div>
      <div className="tenant-filters"><label className="tenant-search"><span><Search size={14}/>Search tenants</span><input placeholder="Business name or tenant code" value={filters.search} onChange={e=>set('search',e.target.value)}/></label>
        <label>Status<select value={filters.status} onChange={e=>set('status',e.target.value)}><option value="">All statuses</option><option>ACTIVE</option><option>SUSPENDED</option></select></label>
        <label>Business type<select value={filters.classification} onChange={e=>set('classification',e.target.value)}><option value="">All types</option><option>BUYER</option><option>SUPPLIER</option><option>HYBRID</option></select></label>
        <label>Country<input placeholder="ISO code" maxLength={2} value={filters.country} onChange={e=>set('country',e.target.value.toUpperCase())}/></label>
        <label>Created from<input type="date" value={filters.createdFrom} onChange={e=>set('createdFrom',e.target.value)}/></label><label>Created to<input type="date" value={filters.createdTo} onChange={e=>set('createdTo',e.target.value)}/></label>
        <label>Sort<select value={`${filters.sort}:${filters.order}`} onChange={e=>{const[sort,order]=e.target.value.split(':');setFilters(f=>({...f,sort,order,page:1}))}}><option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option><option value="createdAt:desc">Newest first</option><option value="createdAt:asc">Oldest first</option></select></label>
      </div>
      {error && <div className="tenant-error" role="alert">{error}<button className="admin-btn" onClick={()=>setRetry(retry+1)}>Retry</button></div>}
      <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table"><thead><tr>{['Tenant','Business type','Country','Status','Members','Commercial access','Created','Last activity','Actions'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>
        {data?.items.map(t=><tr key={t.id}><td><Link className="tenant-name" href={`/tenants/${encodeURIComponent(t.id)}`}>{t.name}</Link><small className="tenant-code">{t.slug}</small></td><td>{t.profile?.classification??'Unclassified'}</td><td>{t.profile?.country??'—'}</td><td><span className={`tenant-status ${t.status.toLowerCase()}`}>{t.status}</span>{t.profile?.stage==='REVIEW'&&<small className="tenant-code">Pending review</small>}</td><td>{t.members??'—'}</td><td><span className="tenant-muted">{t.status==='ACTIVE'?'Subject to entitlements':'New trade restricted'}</span></td><td>{new Date(t.createdAt).toLocaleDateString('en-GB')}</td><td>{t.lastActivity?new Date(t.lastActivity).toLocaleDateString('en-GB'):'Unavailable'}</td><td><Link className="admin-btn" href={`/tenants/${encodeURIComponent(t.id)}`}>Open</Link></td></tr>)}
        {loading&&!data&&<tr><td colSpan={9}>Loading tenant directory…</td></tr>}{!loading&&data&&!data.items.length&&<tr><td colSpan={9}>No tenants match these filters.</td></tr>}
      </tbody></table></div>
      <div className="tenant-pager"><span aria-live="polite">{loading?'Updating…':`Page ${data?.page??1} of ${Math.max(1,Math.ceil((data?.total??0)/(data?.pageSize??25)))}`}</span><button className="admin-btn" disabled={loading||filters.page===1} onClick={()=>setFilters(f=>({...f,page:f.page-1}))}>Previous</button><button className="admin-btn" disabled={loading||!data||data.page*data.pageSize>=data.total} onClick={()=>setFilters(f=>({...f,page:f.page+1}))}>Next</button></div>
    </section>
    {wizard&&<TenantWizard onClose={()=>setWizard(false)} onCreated={id=>{setWizard(false);router.push(`/tenants/${encodeURIComponent(id)}`)}}/>}
  </div>
}
