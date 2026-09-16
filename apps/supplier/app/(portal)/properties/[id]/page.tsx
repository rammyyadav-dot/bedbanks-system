import Link from 'next/link'
import { ArrowLeft, Building2, Image, MapPin, Pencil, Save } from 'lucide-react'
import { notFound } from 'next/navigation'
import { PageHeader } from '../../../../components/ui/PageHeader'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { getSupplierAdapter } from '../../../../lib/adapter'

export default async function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const property = (await getSupplierAdapter().listProperties()).find((item) => item.id === id)
  if (!property) notFound()

  return <div className="supplier-page">
    <Link className="back-link" href="/properties"><ArrowLeft size={12} /> Back to properties</Link>
    <PageHeader eyebrow={`${property.id} · ${property.supplierReference}`} title={property.name} description={`${property.stars}-star property in ${property.destination}, ${property.country}. Content changes remain in UI preview until approved API workflows are connected.`} actions={<><button className="btn"><Pencil size={13} /> Edit profile</button><button className="btn btn-primary"><Save size={13} /> Save draft</button></>} />
    <div className="detail-layout">
      <section className="panel detail-main">
        <div className="detail-hero"><span><Building2 size={32} /></span><div><StatusBadge>{property.status}</StatusBadge><h2>{property.name}</h2><p><MapPin size={12} /> {property.destination}, {property.country} · {property.stars} star</p></div><div className="completion-score"><strong>{property.contentScore}%</strong><small>content complete</small></div></div>
        <div className="tabs" role="tablist"><button className="active">Overview</button><button>Content</button><button>Photos</button><button>Rooms</button><button>Policies</button><button>Contacts</button></div>
        <div className="form-section"><div><p>PROPERTY DETAILS</p><h3>Core information</h3></div><div className="form-grid"><label>Property name<input value={property.name} readOnly /></label><label>Supplier reference<input value={property.supplierReference} readOnly /></label><label>Destination<input value={property.destination} readOnly /></label><label>Country<input value={property.country} readOnly /></label><label>Star rating<input value={`${property.stars} star`} readOnly /></label><label>Timezone<input value="Asia/Dubai (UTC+04:00)" readOnly /></label></div></div>
      </section>
      <aside className="detail-aside">
        <section className="panel checklist"><div className="panel-header"><div><p>READINESS</p><h2>Content checklist</h2></div><strong>{property.contentScore}%</strong></div>{['Core profile', 'Location & contacts', 'Facilities', 'Room types', 'Policies'].map((item, index) => <div className="check-row" key={item}><i className={index < 4 ? 'done' : ''}>{index < 4 ? '✓' : '!'}</i><span>{item}</span><small>{index < 4 ? 'Complete' : 'Review'}</small></div>)}</section>
        <section className="panel media-card"><span><Image size={22} /></span><div><strong>24 property photos</strong><small>4 images need alt text</small></div><button className="row-action"><ArrowLeft size={13} style={{ transform: 'rotate(180deg)' }} /></button></section>
      </aside>
    </div>
  </div>
}
