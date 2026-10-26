'use client'

import { useState } from 'react'
import type { Quotation, QuotationLineItemInput } from '@bedbanks/contracts/agent'
import { createQuotation, updateQuotation } from '@/lib/api-client'
import { formatMinorAmount } from '@/lib/format'
import { previewTotalMinor, validateQuotationDraft } from '@/lib/quotation'
import { useQuotationDraft } from '@/lib/quotation-draft'
import { BrandingPanel } from './branding-panel'
import { ExportActions } from './export-actions'
import { LineItemEditor } from './line-item-editor'

const newKey = () => `quote-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

/**
 * The quotation builder page body. Line items are seeded by the caller from search/offer results (never typed by
 * hand); the agent edits only branding and per-line markup. Saving persists the draft and hands back the
 * server-computed totals that exports are generated from.
 */
export function QuotationBuilder({ tenantId, currency, initialLineItems, existing }: {
  tenantId: string
  currency: string
  initialLineItems: QuotationLineItemInput[]
  existing?: Quotation
}) {
  const { draft, atLineItemLimit, removeLineItem, updateLineItem, setBranding } = useQuotationDraft(currency, {
    branding: existing?.branding,
    lineItems: existing?.lineItems ?? initialLineItems,
  })
  const [saved, setSaved] = useState<Quotation | null>(existing ?? null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const issues = validateQuotationDraft(draft.lineItems, draft.branding)
  const previewTotal = previewTotalMinor(draft.lineItems, currency)

  const save = async () => {
    const validation = validateQuotationDraft(draft.lineItems, draft.branding)
    if (validation) return
    setSaving(true)
    setSaveError('')
    try {
      const result = saved
        ? await updateQuotation(tenantId, saved.id, { branding: draft.branding, lineItems: draft.lineItems, expectedUpdatedAt: saved.updatedAt, idempotencyKey: newKey() })
        : await createQuotation(tenantId, { currency, branding: draft.branding, lineItems: draft.lineItems, idempotencyKey: newKey() })
      setSaved(result)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the quotation')
    } finally {
      setSaving(false)
    }
  }

  return <div className="bb-quote-builder">
    <header className="bb-quote-header">
      <h1>Quotation builder</h1>
      <p>Build a branded proposal from your search results, then export it for your client.</p>
    </header>

    <LineItemEditor currency={currency} lineItems={draft.lineItems} issues={issues?.lineItems} onUpdate={updateLineItem} onRemove={removeLineItem} />
    {atLineItemLimit && <p className="bb-field-hint">You've reached the limit of line items for one proposal.</p>}

    <BrandingPanel branding={draft.branding} issues={issues?.branding} onChange={setBranding} onUploadLogo={() => setSaveError('Logo uploads are not available yet.')} />

    <footer className="bb-quote-footer">
      <div className="bb-quote-total">
        <span>Estimated client total</span>
        <strong>{previewTotal ? formatMinorAmount(previewTotal.amountMinor, previewTotal.currency) : '—'}</strong>
        <small>Final figures are confirmed when you save.</small>
      </div>
      <button type="button" className="bb-quote-save" disabled={saving || draft.lineItems.length === 0} onClick={save}>
        {saving ? 'Saving…' : saved ? 'Save changes' : 'Save quotation'}
      </button>
    </footer>
    {saveError && <p className="bb-field-error">{saveError}</p>}

    {saved && <ExportActions tenantId={tenantId} quotationId={saved.id} disabled={saving} />}
  </div>
}
