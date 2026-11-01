'use client'
import { useRef, useState, type FormEvent } from 'react'
import { routes, type TenantBusiness } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { BusinessFields, emptyBusiness } from './BusinessFields'
const steps = ['Business identity','Legal & compliance','Primary administrator','Commercial setup','Review & create']
export function TenantWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [step,setStep] = useState(0), [business,setBusiness] = useState<TenantBusiness>(emptyBusiness), [slug,setSlug] = useState(''), [email,setEmail] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const key = useRef<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('')
    if (step < 4) { setStep(step+1); return }
    setBusy(true); key.current ??= crypto.randomUUID()
    try { const result = await apiRequest<{id:string}>(routes.platform.tenantCreate,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key.current},body:JSON.stringify({slug,business,administratorEmail:email})}); onCreated(result.id) }
    catch (e) { setError(e instanceof Error ? e.message : 'Tenant creation failed') }
    finally { setBusy(false) }
  }
  return <div className="tenant-modal-backdrop"><section className="tenant-modal" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onKeyDown={e => { if(e.key==='Escape' && !busy) onClose(); if(e.key==='Tab') { const nodes=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]')); const first=nodes[0],last=nodes[nodes.length-1]; if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus()} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus()} } }}>
    <div className="tenant-panel-head"><div><span className="tenant-eyebrow">TENANT ONBOARDING</span><h2 id="wizard-title">Create tenant</h2></div><button type="button" className="admin-btn" onClick={onClose} disabled={busy} autoFocus>Close</button></div>
    <ol className="tenant-steps">{steps.map((s,i) => <li key={s} aria-current={step === i ? 'step' : undefined}>{i+1}. {s}</li>)}</ol>
    <form onSubmit={submit}><h3>{steps[step]}</h3>
      {step===0 && <><BusinessFields value={business} onChange={b => {setBusiness(b);key.current=null}} section="identity" /><label className="tenant-field">Tenant code / slug<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={80} value={slug} onChange={e => {setSlug(e.target.value);key.current=null}} /></label></>}
      {step===1 && <><BusinessFields value={business} onChange={b => {setBusiness(b);key.current=null}} section="legal" /><p className="tenant-note">Compliance starts pending. Verification documents must remain in approved private storage; document upload is unavailable until that workflow is configured.</p></>}
      {step===2 && <><label className="tenant-field">Verified administrator email<input type="email" required value={email} onChange={e => {setEmail(e.target.value);key.current=null}} /></label><p className="tenant-note">Attach an existing active user with a verified sign-in as tenant owner. The operator cannot select themselves. Email invitations require a secure delivery workflow and are currently unavailable.</p></>}
      {step===3 && <BusinessFields value={business} onChange={b => {setBusiness(b);key.current=null}} section="commercial" />}
      {step===4 && <><dl className="tenant-facts">{Object.entries({...business,slug,administratorEmail:email}).map(([k,v]) => <div key={k}><dt>{k.replace(/([A-Z])/g,' $1')}</dt><dd>{Array.isArray(v)? v.join(', ') || 'Unconfigured' : typeof v==='boolean'?v?'Reviewed':'Pending':String(v)||'—'}</dd></div>)}</dl><p className="tenant-note">Tenant is created suspended and pending review. Activation requires readiness checks and a different authorized approver.</p></>}
      {error && <p className="tenant-error" role="alert">{error}</p>}
      <div className="tenant-actions"><button type="button" className="admin-btn" onClick={() => setStep(step-1)} disabled={step===0||busy}>Back</button><button className="admin-btn tenant-primary" disabled={busy}>{busy?'Creating…':step===4?'Create pending tenant':'Continue'}</button></div>
    </form>
  </section></div>
}
