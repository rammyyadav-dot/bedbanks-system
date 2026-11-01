'use client'

import { AGENCY_ADDRESS_MAX, AGENCY_CONTACT_MAX, AGENCY_LEGAL_NAME_MAX, type AgencyBrandingInput } from '@bedbanks/contracts/agent'
import type { QuotationIssue } from '@bedbanks/contracts/agent'

/** Agency branding for the exported proposal: legal name, address and contact details, plus an uploaded logo asset id. */
export function BrandingPanel({ branding, issues, onChange, onUploadLogo }: {
  branding: AgencyBrandingInput
  issues?: QuotationIssue[]
  onChange: (patch: Partial<AgencyBrandingInput>) => void
  onUploadLogo: (file: File) => void
}) {
  const issueFor = (field: string) => issues?.find((issue) => issue.field === field)?.message
  return <section className="bb-quote-branding" aria-labelledby="bb-quote-branding-title">
    <h2 id="bb-quote-branding-title">Your agency branding</h2>
    <p className="bb-quote-branding-hint">Shown on every exported proposal. Your agency's own details, never fabricated placeholder text.</p>
    <div className="bb-quote-branding-grid">
      <label className="bb-field">
        <span>Agency legal name</span>
        <input value={branding.legalName} maxLength={AGENCY_LEGAL_NAME_MAX} onChange={(event) => onChange({ legalName: event.target.value })} aria-invalid={Boolean(issueFor('branding.legalName'))} />
        {issueFor('branding.legalName') && <small className="bb-field-error">{issueFor('branding.legalName')}</small>}
      </label>
      <label className="bb-field">
        <span>Contact email</span>
        <input type="email" value={branding.contactEmail} onChange={(event) => onChange({ contactEmail: event.target.value })} aria-invalid={Boolean(issueFor('branding.contactEmail'))} />
        {issueFor('branding.contactEmail') && <small className="bb-field-error">{issueFor('branding.contactEmail')}</small>}
      </label>
      <label className="bb-field">
        <span>Contact phone</span>
        <input value={branding.contactPhone} maxLength={AGENCY_CONTACT_MAX} onChange={(event) => onChange({ contactPhone: event.target.value })} aria-invalid={Boolean(issueFor('branding.contactPhone'))} />
        {issueFor('branding.contactPhone') && <small className="bb-field-error">{issueFor('branding.contactPhone')}</small>}
      </label>
      <label className="bb-field bb-field-wide">
        <span>Agency address</span>
        <textarea value={branding.address} maxLength={AGENCY_ADDRESS_MAX} onChange={(event) => onChange({ address: event.target.value })} aria-invalid={Boolean(issueFor('branding.address'))} />
        {issueFor('branding.address') && <small className="bb-field-error">{issueFor('branding.address')}</small>}
      </label>
      <label className="bb-field">
        <span>Agency logo</span>
        <input type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUploadLogo(file) }} />
        {branding.logoAssetId && <small className="bb-field-hint">Logo attached</small>}
      </label>
    </div>
  </section>
}
