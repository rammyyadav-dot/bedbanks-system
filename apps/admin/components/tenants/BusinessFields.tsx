'use client'
import type { TenantBusiness } from '@bedbanks/contracts'
export const emptyBusiness: TenantBusiness = { name: '', classification: 'BUYER', country: '', address: '', city: '', businessEmail: '', registrationNumber: '', currency: 'USD', markets: [], channels: ['B2B'], financeReviewed: false }
const identityFields = ['name','tradingName','country','address','city','province','postalCode','website','businessEmail','phone'] as const
const legalFields = ['registrationNumber','taxNumber'] as const
const labels: Record<string,string> = { name:'Registered business name', tradingName:'Trading name', country:'Registration country (ISO code)', address:'Registered address', city:'City', province:'State / province', postalCode:'Postal code', website:'Website', businessEmail:'Business email', phone:'Contact phone', registrationNumber:'Company registration number', taxNumber:'Tax / VAT / GST number' }
export function BusinessFields({ value, onChange, section = 'all' }: { value: TenantBusiness; onChange: (b: TenantBusiness) => void; section?: 'identity' | 'legal' | 'commercial' | 'all' }) {
  const update = (key: keyof TenantBusiness, next: TenantBusiness[keyof TenantBusiness]) => onChange({ ...value, [key]: next })
  const fields = section === 'identity' ? identityFields : section === 'legal' ? legalFields : section === 'all' ? [...identityFields,...legalFields] : []
  return <div className="tenant-form-grid">
    {fields.map(key => <label key={key}>{labels[key]}<input name={key} value={value[key] ?? ''} required={['name','country','address','city','businessEmail','registrationNumber'].includes(key)} maxLength={key === 'address' ? 300 : 160} type={key === 'businessEmail' ? 'email' : key === 'website' ? 'url' : 'text'} pattern={key === 'country' ? '[A-Z]{2}' : undefined} onChange={e => update(key, key === 'country' ? e.target.value.toUpperCase() : e.target.value)} /></label>)}
    {(section === 'commercial' || section === 'all' || section === 'identity') && <label>Business classification<select value={value.classification} onChange={e => update('classification',e.target.value)}><option>BUYER</option><option>SUPPLIER</option><option>HYBRID</option></select></label>}
    {(section === 'commercial' || section === 'all') && <>
      <label>Selling currency<select value={value.currency} onChange={e => update('currency',e.target.value)}>{['USD','AED','EUR','GBP','INR'].map(c => <option key={c}>{c}</option>)}</select></label>
      <label>Business markets (ISO codes, comma separated)<input value={value.markets.join(',')} pattern="[A-Z]{2}(,[A-Z]{2})*" onChange={e => update('markets',e.target.value ? e.target.value.toUpperCase().split(',') : [])} /></label>
      <label>Distribution channel<select value={value.channels[0] ?? ''} onChange={e => update('channels',e.target.value ? [e.target.value] : [])}><option value="">Unconfigured</option><option>B2B</option></select></label>
      <label>Markup policy reference<input value={value.markupPolicyReference ?? ''} onChange={e => update('markupPolicyReference',e.target.value)} /></label>
      <label className="tenant-checkbox"><input type="checkbox" checked={value.financeReviewed} onChange={e => update('financeReviewed',e.target.checked)} />Finance eligibility reviewed (does not enable credit)</label>
      <p className="tenant-note">Commercial preferences do not grant supplier distribution, change pricing rules, or open financial accounts.</p>
    </>}
  </div>
}
