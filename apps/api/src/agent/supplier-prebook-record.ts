export type SupplierPrebookOutcome = 'prebooked' | 'unknown'
export type UncertainSupplierCode = 'timeout' | 'transport'

export interface RecordedSupplierPrebook {
  outcome: SupplierPrebookOutcome
  supplierReference?: string
  code?: UncertainSupplierCode
}

/** Reads the durable supplier-prebook overlay stored beside the commercial snapshot. */
export function readSupplierPrebook(snapshot: unknown): RecordedSupplierPrebook | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const record = (snapshot as { supplierPrebook?: unknown }).supplierPrebook
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const outcome = (record as { outcome?: unknown }).outcome
  if (outcome !== 'prebooked' && outcome !== 'unknown') return null
  const supplierReference = (record as { supplierReference?: unknown }).supplierReference
  const code = (record as { code?: unknown }).code
  return {
    outcome,
    ...(typeof supplierReference === 'string' && supplierReference.length > 0 ? { supplierReference } : {}),
    ...(code === 'timeout' || code === 'transport' ? { code } : {}),
  }
}
