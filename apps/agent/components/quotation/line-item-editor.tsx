'use client'

import type { QuotationIssue, QuotationLineItemInput } from '@bedbanks/contracts/agent'
import { QUOTATION_MARKUP_MAX_BP } from '@bedbanks/contracts/agent'
import { formatMarkupPercent, parseMarkupPercent } from '@/lib/client-markup'
import { formatMinorAmount } from '@/lib/format'
import { previewClientPriceMinor } from '@/lib/quotation'

/**
 * The quotation's line items, each priced from an existing search/offer result. markupBasisPoints is the only field
 * an agent edits here; sellMinor came from the offer and is never retyped by hand. clientPriceMinor shown per row is
 * preview arithmetic — the server recomputes it when the quotation is saved.
 */
export function LineItemEditor({ currency, lineItems, issues, onUpdate, onRemove }: {
  currency: string
  lineItems: QuotationLineItemInput[]
  issues?: QuotationIssue[]
  onUpdate: (index: number, patch: Partial<QuotationLineItemInput>) => void
  onRemove: (index: number) => void
}) {
  const issueFor = (index: number) => issues?.find((issue) => issue.field.startsWith(`lineItems[${index}]`))?.message

  if (lineItems.length === 0) {
    return <p className="bb-quote-empty">No line items yet. Add a hotel from your search results to start this proposal.</p>
  }

  return <div className="bb-quote-lines" role="table" aria-label="Quotation line items">
    <div className="bb-quote-lines-head" role="row">
      <span role="columnheader">Hotel &amp; room</span>
      <span role="columnheader">Stay</span>
      <span role="columnheader">Sell price</span>
      <span role="columnheader">Your markup</span>
      <span role="columnheader">Client price</span>
      <span role="columnheader" aria-label="Remove" />
    </div>
    {lineItems.map((item, index) => {
      const clientPrice = previewClientPriceMinor(item.sellMinor, item.markupBasisPoints, currency)
      const markupText = formatMarkupPercent(item.markupBasisPoints)
      return <div className="bb-quote-line" role="row" key={`${item.sourceOfferId}-${index}`}>
        <span role="cell" className="bb-quote-line-hotel">
          <strong>{item.hotelName}</strong>
          <small>{item.roomTypeName}</small>
        </span>
        <span role="cell">{item.checkIn} – {item.checkOut} · {item.nights} night{item.nights === 1 ? '' : 's'}</span>
        <span role="cell">{formatMinorAmount(item.sellMinor, currency) ?? '—'}</span>
        <span role="cell">
          <input
            inputMode="decimal"
            value={markupText}
            aria-label={`Markup percent for ${item.hotelName}`}
            onChange={(event) => {
              const parsed = parseMarkupPercent(event.target.value)
              if (parsed.ok && parsed.basisPoints <= QUOTATION_MARKUP_MAX_BP) onUpdate(index, { markupBasisPoints: parsed.basisPoints })
            }}
          />%
        </span>
        <span role="cell" className="bb-quote-line-price">{clientPrice ? formatMinorAmount(clientPrice.amountMinor, clientPrice.currency) : '—'}</span>
        <span role="cell">
          <button type="button" className="bb-quote-line-remove" onClick={() => onRemove(index)} aria-label={`Remove ${item.hotelName} from the quotation`}>Remove</button>
        </span>
        {issueFor(index) && <small className="bb-field-error bb-quote-line-error" role="cell">{issueFor(index)}</small>}
      </div>
    })}
  </div>
}
