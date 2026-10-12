/**
 * Supplier extranet read models (ADR 0011, ADR 0061). Every route is scoped server-side to the caller's active supplier
 * organization. No identifier here is an authorization input. Monetary amounts are deliberately absent from this slice.
 */
export type ExtranetPermission =
  | 'supplier.extranet.hotels.read'
  | 'supplier.extranet.rooms.read'
  | 'supplier.extranet.drafts.manage'
  | 'supplier.extranet.contracts.read'

/** GET /supplier/extranet/contracts (`supplier.extranet.contracts.read`). Read-only; the supplier cannot create or change a contract here. */
export interface ExtranetRatePlanSummary {
  id: string
  code: string
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'
  roomTypeName: string
  boardBasis: string
  refundable: boolean
  occupancy: number
  /** ISO-4217. */
  currency: string
  /** ISO dates (YYYY-MM-DD). Null inherits the contract term. */
  validFrom: string | null
  validTo: string | null
}

export interface ExtranetContractSummary {
  id: string
  code: string
  status: 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED'
  hotelId: string | null
  hotelName: string | null
  validFrom: string
  validTo: string
  /** ISO-4217. */
  settlementCurrency: string
  ratePlans: ExtranetRatePlanSummary[]
}

export interface ExtranetContractList { contracts: ExtranetContractSummary[] }
