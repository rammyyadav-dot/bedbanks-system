import Link from 'next/link'
import { ArrowLeft, Building2, Image, MapPin, Pencil, Save } from 'lucide-react'
import { notFound } from 'next/navigation'
import { PageHeader } from '../../../../components/ui/PageHeader'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { getSupplierAdapter } from '../../../../lib/adapter'

export default async function HotelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const hotel = (await getSupplierAdapter().listProperties()).find((item) => item.id === id)
  if (!hotel) notFound()

  return <div className="supplier-page">
    <Link className="back-link" href="/hotels"><ArrowLeft size={12} /> Back to hotels</Link>
    <PageHeader eyebrow={`${hotel.id} · ${hotel.supplierReference}`} title={hotel.name} description={`${hotel.stars}-star hotel in ${hotel.destination}, ${hotel.country}. Content changes remain in UI preview until approved API workflows are connected.`} actions={<><button className="btn"><Pencil size={13} /> Edit profile</button><button className="btn btn-primary"><Save size={13} /> Save draft</button></>} />
    <div className="detail-layout"><section className="panel detail-main"><div className="detail-hero"><span><Building2 size={32} /></span><div><StatusBadge>{hotel.status}</StatusBadge><h2>{hotel.name}</h2><p><MapPin size={12} /> {hotel.destination}, {hotel.country} · {hotel.stars} star</p></div><div className="completion-score"><strong>{hotel.contentScore}%</strong><small>content complete</small></div></div>
      <div className="tabs" role="tablist"><button className="active">Overview</button><button>Content</button><button>Photos</button><button>Rooms</button><button>Policies</button><button>Contacts</button></div>
      <div className="form-section"><div><p>HOTEL DETAILS</p><h3>Core information</h3></div><div className="form-grid"><label>Hotel name<input value={hotel.name} readOnly /></label><label>Supplier reference<input value={hotel.supplierReference} readOnly /></label><label>Destination<input value={hotel.destination} readOnly /></label><label>Country<input value={hotel.country} readOnly /></label><label>Star rating<input value={`${hotel.stars} star`} readOnly /></label><label>Timezone<input value="Asia/Dubai (UTC+04:00)" readOnly /></label></div></div></section>
      <aside className="detail-aside"><section className="panel checklist"><div className="panel-header"><div><p>READINESS</p><h2>Content checklist</h2></div><strong>{hotel.contentScore}%</strong></div>{['Core profile', 'Location & contacts', 'Facilities', 'Room types', 'Policies'].map((item, index) => <div className="check-row" key={item}><i className={index < 4 ? 'done' : ''}>{index < 4 ? '✓' : '!'}</i><span>{item}</span><small>{index < 4 ? 'Complete' : 'Review'}</small></div>)}</section><section className="panel media-card"><span><Image size={22} /></span><div><strong>24 hotel photos</strong><small>4 images need alt text</small></div><button className="row-action" aria-label="Open hotel photos"><ArrowLeft size={13} style={{ transform: 'rotate(180deg)' }} /></button></section></aside>
    </div>
  </div>
}
