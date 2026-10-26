'use client'

import { useReducer } from 'react'
import type { AgencyBrandingInput, QuotationLineItemInput } from '@bedbanks/contracts/agent'
import { QUOTATION_LINE_ITEM_MAX, emptyBranding } from './quotation'

export type QuotationDraft = { currency: string; branding: AgencyBrandingInput; lineItems: QuotationLineItemInput[] }

type Action =
  | { type: 'addLineItem'; item: QuotationLineItemInput }
  | { type: 'removeLineItem'; index: number }
  | { type: 'updateLineItem'; index: number; patch: Partial<QuotationLineItemInput> }
  | { type: 'setBranding'; branding: Partial<AgencyBrandingInput> }
  | { type: 'reset'; draft: QuotationDraft }

function reduce(state: QuotationDraft, action: Action): QuotationDraft {
  switch (action.type) {
    case 'addLineItem':
      return state.lineItems.length >= QUOTATION_LINE_ITEM_MAX ? state : { ...state, lineItems: [...state.lineItems, action.item] }
    case 'removeLineItem':
      return { ...state, lineItems: state.lineItems.filter((_, index) => index !== action.index) }
    case 'updateLineItem':
      return { ...state, lineItems: state.lineItems.map((item, index) => (index === action.index ? { ...item, ...action.patch } : item)) }
    case 'setBranding':
      return { ...state, branding: { ...state.branding, ...action.branding } }
    case 'reset':
      return action.draft
    default:
      return state
  }
}

export function useQuotationDraft(currency: string, initial?: Partial<QuotationDraft>) {
  const [draft, dispatch] = useReducer(reduce, {
    currency,
    branding: initial?.branding ?? emptyBranding(),
    lineItems: initial?.lineItems ?? [],
  })

  return {
    draft,
    atLineItemLimit: draft.lineItems.length >= QUOTATION_LINE_ITEM_MAX,
    addLineItem: (item: QuotationLineItemInput) => dispatch({ type: 'addLineItem', item }),
    removeLineItem: (index: number) => dispatch({ type: 'removeLineItem', index }),
    updateLineItem: (index: number, patch: Partial<QuotationLineItemInput>) => dispatch({ type: 'updateLineItem', index, patch }),
    setBranding: (branding: Partial<AgencyBrandingInput>) => dispatch({ type: 'setBranding', branding }),
    reset: (next: QuotationDraft) => dispatch({ type: 'reset', draft: next }),
  }
}
